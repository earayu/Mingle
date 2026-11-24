import https from "node:https";
import net, { isIP } from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { Agent, Dispatcher, getGlobalDispatcher, ProxyAgent, setGlobalDispatcher } from "undici";
import { type ParsedProxyUrl, parseProxyUrl, type ResolvedProxy, shouldBypass } from "./proxy.ts";

/**
 * Unified outbound proxy transport for Mingle:
 * - Installs a dynamic undici `Dispatcher` globally so Node's built-in `fetch()` and
 *   `WebSocket()` (Telegram, Discord, Slack, GitHub, WeChat, etc.) respect Mingle's
 *   proxy mode, bypass list, and runtime changes without restarting.
 * - Supports HTTP/HTTPS proxies and pure-Node SOCKS5/SOCKS5h (RFC 1928 + RFC 1929 with
 *   remote DNS resolution) with zero experimental Node warnings.
 * - Installs a matching `https.globalAgent` so third-party SDKs built on `ws` / `https`
 *   also follow the same proxy and bypass rules.
 */

export type ProxyTestErrorCode = "proxy_timeout" | "proxy_auth_failed" | "proxy_unreachable";

export type ProxyTestResult =
  | { readonly ok: true; readonly latencyMs: number }
  | { readonly ok: false; readonly code: ProxyTestErrorCode };

class ProxyConnectError extends Error {
  readonly code: ProxyTestErrorCode;
  constructor(code: ProxyTestErrorCode, message: string) {
    super(message);
    this.name = "ProxyConnectError";
    this.code = code;
  }
}

/** Buffered reader over a raw socket that preserves trailing bytes via `socket.unshift()`. */
function createSocketReader(socket: net.Socket, timeoutMs: number) {
  let buffer: Buffer = Buffer.alloc(0);
  let closed: Error | null = null;
  let waiting: { resolve: () => void; reject: (err: Error) => void } | null = null;

  const fail = (err: Error) => {
    if (closed) return;
    closed = err;
    const w = waiting;
    waiting = null;
    w?.reject(err);
  };

  const onData = (chunk: Buffer) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    const w = waiting;
    if (w) {
      waiting = null;
      w.resolve();
    }
  };
  const onError = (err: Error) => fail(err);
  const onClose = () => fail(new ProxyConnectError("proxy_unreachable", "proxy closed connection during handshake"));
  const timer = setTimeout(() => {
    const err = new ProxyConnectError("proxy_timeout", "proxy handshake timed out");
    fail(err);
    socket.destroy(err);
  }, timeoutMs);

  socket.on("data", onData);
  socket.once("error", onError);
  socket.once("close", onClose);

  const waitMore = () =>
    new Promise<void>((resolve, reject) => {
      if (closed) reject(closed);
      else waiting = { resolve, reject };
    });

  return {
    async readExact(n: number): Promise<Buffer> {
      while (buffer.length < n) await waitMore();
      const out = buffer.subarray(0, n);
      buffer = buffer.subarray(n);
      return out;
    },
    async readUntil(marker: Buffer, maxBytes = 16 * 1024): Promise<Buffer> {
      while (true) {
        const idx = buffer.indexOf(marker);
        if (idx !== -1) {
          const end = idx + marker.length;
          const out = buffer.subarray(0, end);
          buffer = buffer.subarray(end);
          return out;
        }
        if (buffer.length > maxBytes) {
          throw new ProxyConnectError("proxy_unreachable", "proxy response header too large");
        }
        await waitMore();
      }
    },
    detach() {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (buffer.length > 0) {
        const leftover = buffer;
        buffer = Buffer.alloc(0);
        socket.unshift(leftover);
      }
    },
  };
}

function connectSocket(host: string, port: number, useTls: boolean, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, sock?: net.Socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        sock?.destroy();
        reject(err);
      } else if (sock) {
        resolve(sock);
      }
    };
    const sock: net.Socket = useTls
      ? tls.connect({
          host,
          port,
          ...(isIP(host) === 0 ? { servername: host } : {}),
        })
      : net.connect({ host, port });

    const timer = setTimeout(() => {
      finish(new ProxyConnectError("proxy_timeout", "timed out connecting to proxy"), sock);
    }, timeoutMs);

    const onReady = () => {
      sock.off("error", onError);
      finish(null, sock);
    };
    const onError = (err: Error) => {
      sock.off(useTls ? "secureConnect" : "connect", onReady);
      finish(new ProxyConnectError("proxy_unreachable", err.message), sock);
    };
    sock.once(useTls ? "secureConnect" : "connect", onReady);
    sock.once("error", onError);
  });
}

async function socks5Negotiate(
  socket: net.Socket,
  reader: ReturnType<typeof createSocketReader>,
  proxy: ParsedProxyUrl,
): Promise<void> {
  const methods = proxy.auth ? [0x00, 0x02] : [0x00];
  socket.write(Buffer.from([0x05, methods.length, ...methods]));
  const greeting = await reader.readExact(2);
  if (greeting[0] !== 0x05) {
    throw new ProxyConnectError("proxy_unreachable", "unexpected SOCKS5 version");
  }
  const chosen = greeting[1];
  if (chosen === 0xff) {
    throw new ProxyConnectError("proxy_auth_failed", "SOCKS5 proxy rejected authentication methods");
  }
  if (chosen === 0x02) {
    if (!proxy.auth) {
      throw new ProxyConnectError("proxy_auth_failed", "SOCKS5 proxy requires authentication");
    }
    const userBuf = Buffer.from(proxy.auth.username, "utf8");
    const passBuf = Buffer.from(proxy.auth.password, "utf8");
    if (userBuf.length > 255 || passBuf.length > 255) {
      throw new ProxyConnectError("proxy_auth_failed", "SOCKS5 credentials exceed 255 bytes");
    }
    socket.write(Buffer.concat([Buffer.from([0x01, userBuf.length]), userBuf, Buffer.from([passBuf.length]), passBuf]));
    const authReply = await reader.readExact(2);
    if (authReply[1] !== 0x00) {
      throw new ProxyConnectError("proxy_auth_failed", "SOCKS5 authentication failed");
    }
  } else if (chosen !== 0x00) {
    throw new ProxyConnectError("proxy_unreachable", `unsupported SOCKS5 auth method ${chosen}`);
  }
}

function encodeSocks5Address(targetHost: string): Buffer {
  const cleanHost = targetHost.replace(/^\[|\]$/g, "");
  const ipKind = isIP(cleanHost);
  if (ipKind === 4) {
    const octets = cleanHost.split(".").map(Number);
    return Buffer.from([0x01, ...octets]);
  }
  if (ipKind === 6) {
    // Expand IPv6 into 16 bytes
    const [head, tail] = cleanHost.split("::");
    const headParts = head ? head.split(":").filter(Boolean) : [];
    const tailParts = tail ? tail.split(":").filter(Boolean) : [];
    const missing = 8 - headParts.length - tailParts.length;
    const full = [...headParts, ...Array<string>(Math.max(0, missing)).fill("0"), ...tailParts];
    const bytes = Buffer.alloc(17);
    bytes[0] = 0x04;
    for (let i = 0; i < 8; i++) {
      bytes.writeUInt16BE(Number.parseInt(full[i] || "0", 16), 1 + i * 2);
    }
    return bytes;
  }
  // Domain name (ATYP 0x03): proxy performs DNS resolution (socks5h behavior).
  const hostBuf = Buffer.from(cleanHost, "utf8");
  if (hostBuf.length > 255) {
    throw new ProxyConnectError("proxy_unreachable", "target hostname exceeds 255 bytes");
  }
  return Buffer.concat([Buffer.from([0x03, hostBuf.length]), hostBuf]);
}

/** Opens a raw TCP tunnel through a SOCKS5/SOCKS5h proxy to `targetHost:targetPort`. */
export async function connectSocks5Tunnel(
  proxy: ParsedProxyUrl,
  targetHost: string,
  targetPort: number,
  timeoutMs = 15_000,
): Promise<net.Socket> {
  const socket = await connectSocket(proxy.hostname, proxy.port, false, timeoutMs);
  const reader = createSocketReader(socket, timeoutMs);
  try {
    await socks5Negotiate(socket, reader, proxy);
    const addr = encodeSocks5Address(targetHost);
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(targetPort, 0);
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr, portBuf]));

    const head = await reader.readExact(4);
    if (head[0] !== 0x05) {
      throw new ProxyConnectError("proxy_unreachable", "unexpected SOCKS5 connect response");
    }
    if (head[1] !== 0x00) {
      throw new ProxyConnectError("proxy_unreachable", `SOCKS5 connect failed with code ${head[1]}`);
    }
    const atyp = head[3];
    if (atyp === 0x01) await reader.readExact(4 + 2);
    else if (atyp === 0x04) await reader.readExact(16 + 2);
    else if (atyp === 0x03) {
      const len = (await reader.readExact(1))[0] ?? 0;
      await reader.readExact(len + 2);
    } else {
      throw new ProxyConnectError("proxy_unreachable", `unexpected SOCKS5 address type ${atyp}`);
    }
    reader.detach();
    return socket;
  } catch (error) {
    reader.detach();
    socket.destroy();
    throw error;
  }
}

/** Opens a raw TCP tunnel through an HTTP/HTTPS proxy using CONNECT. */
export async function connectHttpTunnel(
  proxy: ParsedProxyUrl,
  targetHost: string,
  targetPort: number,
  timeoutMs = 15_000,
): Promise<net.Socket> {
  const socket = await connectSocket(proxy.hostname, proxy.port, proxy.protocol === "https:", timeoutMs);
  const reader = createSocketReader(socket, timeoutMs);
  try {
    const cleanHost = targetHost.replace(/^\[|\]$/g, "");
    const authority = cleanHost.includes(":") ? `[${cleanHost}]:${targetPort}` : `${cleanHost}:${targetPort}`;
    const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
    if (proxy.auth) {
      const basic = Buffer.from(`${proxy.auth.username}:${proxy.auth.password}`, "utf8").toString("base64");
      lines.push(`Proxy-Authorization: Basic ${basic}`);
    }
    lines.push("", "");
    socket.write(lines.join("\r\n"));

    const rawHeaders = await reader.readUntil(Buffer.from("\r\n\r\n"));
    const statusLine = rawHeaders.toString("latin1").split("\r\n", 1)[0] ?? "";
    const statusMatch = /^HTTP\/\d+\.\d+\s+(\d{3})/.exec(statusLine);
    const status = statusMatch ? Number(statusMatch[1]) : 0;
    if (status === 407) {
      throw new ProxyConnectError("proxy_auth_failed", "HTTP proxy requires authentication");
    }
    if (status !== 200) {
      throw new ProxyConnectError("proxy_unreachable", `HTTP proxy CONNECT failed (${statusLine || "invalid reply"})`);
    }
    reader.detach();
    return socket;
  } catch (error) {
    reader.detach();
    socket.destroy();
    throw error;
  }
}

function upgradeToTls(
  socket: net.Socket,
  targetHost: string,
  tlsOptions?: tls.ConnectionOptions,
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const cleanHost = targetHost.replace(/^\[|\]$/g, "");
    const tlsSock = tls.connect({
      ...tlsOptions,
      socket,
      ...(isIP(cleanHost) === 0 ? { servername: tlsOptions?.servername ?? cleanHost } : {}),
    });
    const onError = (err: Error) => {
      tlsSock.off("secureConnect", onSecure);
      tlsSock.destroy();
      reject(err);
    };
    const onSecure = () => {
      tlsSock.off("error", onError);
      resolve(tlsSock);
    };
    tlsSock.once("secureConnect", onSecure);
    tlsSock.once("error", onError);
  });
}

function createSocks5UndiciAgent(proxy: ParsedProxyUrl): Agent {
  return new Agent({
    connect(opts, callback) {
      const targetHost = opts.hostname;
      const targetPort = opts.port ? Number(opts.port) : opts.protocol === "https:" ? 443 : 80;
      const wantTls = opts.protocol === "https:";
      void (async () => {
        const raw = await connectSocks5Tunnel(proxy, targetHost, targetPort);
        if (!wantTls) return raw;
        return upgradeToTls(raw, targetHost, {
          ...(opts.servername ? { servername: opts.servername } : {}),
        });
      })().then(
        (sock) => callback(null, sock),
        (err) => callback(err instanceof Error ? err : new Error(String(err)), null),
      );
    },
  });
}

function createProxyDispatcher(proxy: ParsedProxyUrl): Dispatcher {
  if (proxy.protocol === "socks5:" || proxy.protocol === "socks5h:") {
    return createSocks5UndiciAgent(proxy);
  }
  const token = proxy.auth
    ? `Basic ${Buffer.from(`${proxy.auth.username}:${proxy.auth.password}`, "utf8").toString("base64")}`
    : undefined;
  return new ProxyAgent({
    uri: proxy.cleanUrl,
    ...(token ? { token } : {}),
  });
}

/**
 * Dynamic undici Dispatcher that routes requests per-origin through the active proxy
 * or directly when bypassed (always direct for loopback). Can be updated live at runtime.
 */
export class DynamicProxyDispatcher extends Dispatcher {
  private readonly direct: Agent;
  private proxyDispatcher: Dispatcher | null = null;
  private activeBypass: readonly string[] = [];
  private activeParsed: ParsedProxyUrl | null = null;
  private activeKey: string | null = null;

  constructor() {
    super();
    this.direct = new Agent();
  }

  /** Applies a newly resolved proxy (or `null` for direct) and closes any replaced pool. */
  configure(resolved: ResolvedProxy | null): void {
    const key = resolved ? `${resolved.url}\0${resolved.bypass.join(",")}` : null;
    if (key === this.activeKey) return;
    this.activeKey = key;
    const previous = this.proxyDispatcher;
    if (!resolved) {
      this.proxyDispatcher = null;
      this.activeBypass = [];
      this.activeParsed = null;
    } else {
      const parsed = parseProxyUrl(resolved.url);
      this.proxyDispatcher = createProxyDispatcher(parsed);
      this.activeBypass = resolved.bypass;
      this.activeParsed = parsed;
    }
    if (previous) void previous.close().catch(() => {});
  }

  /** The parsed active proxy and bypass rules, for sharing with `DynamicHttpsAgent`. */
  current(): { readonly proxy: ParsedProxyUrl; readonly bypass: readonly string[] } | null {
    return this.activeParsed ? { proxy: this.activeParsed, bypass: this.activeBypass } : null;
  }

  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    if (!this.proxyDispatcher) return this.direct.dispatch(options, handler);
    const target = extractOriginHostPort(options.origin);
    if (!target || shouldBypass(target.hostname, target.port, this.activeBypass)) {
      return this.direct.dispatch(options, handler);
    }
    return this.proxyDispatcher.dispatch(options, handler);
  }

  override close(): Promise<void>;
  override close(callback: () => void): void;
  override close(callback?: () => void): Promise<void> | undefined {
    const prev = this.proxyDispatcher;
    this.proxyDispatcher = null;
    const done = Promise.all([this.direct.close().catch(() => {}), prev?.close().catch(() => {})]).then(() => {});
    if (callback) {
      void done.then(callback);
      return undefined;
    }
    return done;
  }

  override destroy(): Promise<void>;
  override destroy(err: Error | null): Promise<void>;
  override destroy(callback: () => void): void;
  override destroy(err: Error | null, callback: () => void): void;
  override destroy(err?: Error | null | (() => void), callback?: () => void): Promise<void> | undefined {
    const error = typeof err === "function" ? null : (err ?? null);
    const cb = typeof err === "function" ? err : callback;
    const prev = this.proxyDispatcher;
    this.proxyDispatcher = null;
    const done = Promise.all([this.direct.destroy(error).catch(() => {}), prev?.destroy(error).catch(() => {})]).then(
      () => {},
    );
    if (cb) {
      void done.then(cb);
      return undefined;
    }
    return done;
  }
}

function extractOriginHostPort(origin: string | URL | undefined): { hostname: string; port: string } | null {
  if (!origin) return null;
  try {
    const parsed = origin instanceof URL ? origin : new URL(origin);
    const port = parsed.port || (parsed.protocol === "https:" || parsed.protocol === "wss:" ? "443" : "80");
    return { hostname: parsed.hostname, port };
  } catch {
    return null;
  }
}

/**
 * Dynamic `https.Agent` that routes HTTPS / WSS traffic (used by `ws` and `https.request`
 * in third-party IM SDKs) through the active HTTP/HTTPS CONNECT or SOCKS5 proxy.
 */
export class DynamicHttpsAgent extends https.Agent {
  private readonly getActive: () => { readonly proxy: ParsedProxyUrl; readonly bypass: readonly string[] } | null;

  constructor(getActive: () => { readonly proxy: ParsedProxyUrl; readonly bypass: readonly string[] } | null) {
    super({ keepAlive: true });
    this.getActive = getActive;
  }

  override createConnection(
    options: https.RequestOptions,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const active = this.getActive();
    const host = String(options.hostname ?? options.host ?? "");
    const port = Number(options.port ?? 443);
    if (!active || !host || shouldBypass(host, port, active.bypass)) {
      return super.createConnection(options, callback);
    }
    const open =
      active.proxy.protocol === "socks5:" || active.proxy.protocol === "socks5h:"
        ? connectSocks5Tunnel(active.proxy, host, port)
        : connectHttpTunnel(active.proxy, host, port);

    void open
      .then((tunnel) =>
        upgradeToTls(tunnel, host, {
          ...(typeof options.servername === "string" ? { servername: options.servername } : {}),
          ...(options.rejectUnauthorized !== undefined ? { rejectUnauthorized: options.rejectUnauthorized } : {}),
        }),
      )
      .then(
        (tlsSocket) => callback?.(null, tlsSocket),
        (err) => callback?.(err instanceof Error ? err : new Error(String(err)), undefined as unknown as Duplex),
      );
    return undefined;
  }
}

export interface NetworkProxyController {
  readonly dispatcher: DynamicProxyDispatcher;
  readonly httpsAgent: DynamicHttpsAgent;
  apply(resolved: ResolvedProxy | null): void;
  restore(): void;
}

/**
 * Installs Mingle's dynamic proxy dispatcher globally (affecting Node's built-in `fetch`,
 * `WebSocket`, and `https.globalAgent`). Call `restore()` in tests or shutdown.
 */
export function installNetworkProxy(): NetworkProxyController {
  const prevDispatcher = getGlobalDispatcher();
  const prevHttpsAgent = https.globalAgent;
  const dispatcher = new DynamicProxyDispatcher();
  const httpsAgent = new DynamicHttpsAgent(() => dispatcher.current());
  setGlobalDispatcher(dispatcher);
  https.globalAgent = httpsAgent;
  return {
    dispatcher,
    httpsAgent,
    apply(resolved) {
      dispatcher.configure(resolved);
    },
    restore() {
      setGlobalDispatcher(prevDispatcher);
      https.globalAgent = prevHttpsAgent;
      void dispatcher.close().catch(() => {});
    },
  };
}

/**
 * Tests reachability (and SOCKS5 protocol/auth handshake when applicable) of a proxy URL.
 * Connects only to the proxy endpoint itself — no external server or telemetry is contacted.
 */
export async function testProxyConnection(rawUrl: string, timeoutMs = 5000): Promise<ProxyTestResult> {
  const parsed = parseProxyUrl(rawUrl);
  const start = performance.now();
  let socket: net.Socket | undefined;
  try {
    if (parsed.protocol === "socks5:" || parsed.protocol === "socks5h:") {
      socket = await connectSocket(parsed.hostname, parsed.port, false, timeoutMs);
      const reader = createSocketReader(socket, timeoutMs);
      try {
        await socks5Negotiate(socket, reader, parsed);
      } finally {
        reader.detach();
      }
    } else {
      socket = await connectSocket(parsed.hostname, parsed.port, parsed.protocol === "https:", timeoutMs);
    }
    const latencyMs = Math.max(1, Math.round(performance.now() - start));
    return { ok: true, latencyMs };
  } catch (error) {
    const code: ProxyTestErrorCode = error instanceof ProxyConnectError ? error.code : "proxy_unreachable";
    return { ok: false, code };
  } finally {
    socket?.destroy();
  }
}
