import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import type { ScriptedTurn } from "@botiverse/oar/testing";
import { afterEach, describe, expect, it } from "vitest";
import { DynamicProxyDispatcher, installNetworkProxy, testProxyConnection } from "../src/platform/net.ts";
import {
  buildHarnessProxyEnv,
  decodeProxyAuth,
  detectSystemProxy,
  maskProxyUrl,
  PROXY_AUTH_KEY,
  parseEnvProxy,
  parseProxyUrl,
  parseScutilProxy,
  parseWinInetProxy,
  shouldBypass,
} from "../src/platform/proxy.ts";
import { memorySecrets } from "../src/platform/secrets.ts";
import { messageIds, type Rig, rig, runCliNode, until } from "./helpers.ts";

/** Global network proxy parsing, OS detection, SOCKS5/HTTP transport, API, and harness propagation. */

let current: Rig | undefined;
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  await current?.close();
  current = undefined;
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function listenServer(server: net.Server | http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") reject(new Error("no tcp address"));
      else resolve(addr.port);
    });
  });
}

/** Minimal local SOCKS5 server (RFC 1928 + RFC 1929) for real end-to-end tunnel tests. */
async function startMockSocks5(options: { auth?: { user: string; pass: string } } = {}) {
  const targets: { host: string; port: number }[] = [];
  const server = net.createServer((client) => {
    let stage: "greeting" | "auth" | "request" | "relay" = "greeting";
    let buf: Buffer = Buffer.alloc(0);
    let upstream: net.Socket | undefined;

    const processBuf = () => {
      if (stage === "greeting") {
        if (buf.length < 2) return;
        const nMethods = buf[1] ?? 0;
        if (buf.length < 2 + nMethods) return;
        const methods = [...buf.subarray(2, 2 + nMethods)];
        buf = buf.subarray(2 + nMethods);
        if (options.auth) {
          if (methods.includes(0x02)) {
            client.write(Buffer.from([0x05, 0x02]));
            stage = "auth";
            processBuf();
          } else {
            client.end(Buffer.from([0x05, 0xff]));
          }
        } else {
          client.write(Buffer.from([0x05, 0x00]));
          stage = "request";
          processBuf();
        }
        return;
      }
      if (stage === "auth") {
        if (buf.length < 2) return;
        const ulen = buf[1] ?? 0;
        if (buf.length < 2 + ulen + 1) return;
        const plen = buf[2 + ulen] ?? 0;
        if (buf.length < 2 + ulen + 1 + plen) return;
        const user = buf.subarray(2, 2 + ulen).toString("utf8");
        const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString("utf8");
        buf = buf.subarray(3 + ulen + plen);
        if (user === options.auth?.user && pass === options.auth?.pass) {
          client.write(Buffer.from([0x01, 0x00]));
          stage = "request";
          processBuf();
        } else {
          client.end(Buffer.from([0x01, 0x01]));
        }
        return;
      }
      if (stage === "request") {
        if (buf.length < 4) return;
        const atyp = buf[3];
        let host = "";
        let offset = 4;
        if (atyp === 0x01) {
          if (buf.length < 4 + 4 + 2) return;
          host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
          offset = 8;
        } else if (atyp === 0x03) {
          if (buf.length < 5) return;
          const len = buf[4] ?? 0;
          if (buf.length < 5 + len + 2) return;
          host = buf.subarray(5, 5 + len).toString("utf8");
          offset = 5 + len;
        } else {
          client.destroy();
          return;
        }
        const port = buf.readUInt16BE(offset);
        buf = buf.subarray(offset + 2);
        targets.push({ host, port });
        // Connect to a local target when host is "mock.local" or IP, otherwise reply with success and echo HTTP.
        stage = "relay";
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
        if (host === "echo.test") {
          const respond = (chunk: Buffer) => {
            if (chunk.toString("latin1").includes("\r\n\r\n")) {
              const body = JSON.stringify({ via: "socks5", host, port });
              client.end(
                `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
              );
            }
          };
          client.on("data", respond);
          if (buf.length > 0) respond(buf);
          return;
        }
        upstream = net.connect(port, host, () => {
          if (buf.length > 0) upstream?.write(buf);
          client.pipe(upstream as net.Socket);
          upstream?.pipe(client);
        });
        upstream.on("error", () => client.destroy());
      }
    };

    client.on("data", (chunk) => {
      if (stage === "relay") return;
      buf = Buffer.concat([buf, chunk]);
      processBuf();
    });
    client.on("close", () => upstream?.destroy());
  });
  const port = await listenServer(server);
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { port, targets };
}

describe("proxy URL parsing and bypass matching", () => {
  it("parses valid URLs, strips auth, and masks credentials", () => {
    const http = parseProxyUrl("http://127.0.0.1:7890/");
    expect(http).toMatchObject({
      protocol: "http:",
      hostname: "127.0.0.1",
      port: 7890,
      cleanUrl: "http://127.0.0.1:7890",
      auth: null,
    });

    const auth = parseProxyUrl("socks5://alice:s3cr%40t@proxy.example.com:1080");
    expect(auth).toMatchObject({
      protocol: "socks5:",
      hostname: "proxy.example.com",
      port: 1080,
      cleanUrl: "socks5://proxy.example.com:1080",
      auth: { username: "alice", password: "s3cr@t" },
    });
    expect(maskProxyUrl(auth.cleanUrl, true)).toBe("socks5://••••••@proxy.example.com:1080");
    expect(maskProxyUrl(http.cleanUrl, false)).toBe("http://127.0.0.1:7890");
  });

  it("rejects invalid and unsupported proxy URLs", () => {
    expect(() => parseProxyUrl("")).toThrow(/proxy_url_required/);
    expect(() => parseProxyUrl("not a url")).toThrow(/proxy_url_invalid/);
    expect(() => parseProxyUrl("ftp://127.0.0.1:21")).toThrow(/proxy_protocol_unsupported/);
  });

  it("always bypasses loopback and respects domain, wildcard, port, and CIDR rules", () => {
    expect(shouldBypass("127.0.0.1", 7419, [])).toBe(true);
    expect(shouldBypass("localhost", 7419, [])).toBe(true);
    expect(shouldBypass("::1", 7419, [])).toBe(true);
    expect(shouldBypass("api.telegram.org", 443, [])).toBe(false);

    const rules = ["*.local", ".corp.internal", "10.0.0.0/8", "192.168.0.0/16", "git.example.com:8443", "<local>"];
    expect(shouldBypass("printer.local", 80, rules)).toBe(true);
    expect(shouldBypass("api.corp.internal", 443, rules)).toBe(true);
    expect(shouldBypass("10.12.34.56", 443, rules)).toBe(true);
    expect(shouldBypass("192.168.1.5", 443, rules)).toBe(true);
    expect(shouldBypass("172.16.0.1", 443, rules)).toBe(false);
    expect(shouldBypass("git.example.com", 8443, rules)).toBe(true);
    expect(shouldBypass("git.example.com", 443, rules)).toBe(false);
    expect(shouldBypass("intranet", 80, rules)).toBe(true);
    expect(shouldBypass("api.telegram.org", 443, rules)).toBe(false);
  });
});

describe("OS system proxy parsers", () => {
  it("parses macOS scutil --proxy output (HTTP/HTTPS, SOCKS-only, PAC-only, ExceptionsList)", () => {
    const clash = parseScutilProxy(`
<dictionary> {
  ExceptionsList : <array> {
    0 : 192.168.0.0/16
    1 : *.local
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7891
  SOCKSProxy : 127.0.0.1
}
`);
    expect(clash).toMatchObject({
      url: "http://127.0.0.1:7890",
      httpsUrl: "http://127.0.0.1:7890",
      httpUrl: "http://127.0.0.1:7890",
      socksUrl: "socks5h://127.0.0.1:7891",
      bypass: ["192.168.0.0/16", "*.local"],
      pacOnly: false,
      source: "os",
    });

    const socksOnly = parseScutilProxy(`
<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 1080
  SOCKSProxy : 127.0.0.1
}
`);
    expect(socksOnly).toMatchObject({ url: "socks5h://127.0.0.1:1080", pacOnly: false, source: "os" });

    const pacOnly = parseScutilProxy(`
<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 0
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://127.0.0.1:8000/proxy.pac
}
`);
    expect(pacOnly).toMatchObject({ url: null, pacOnly: true, source: "none" });
  });

  it("parses Windows WinINET registry output", () => {
    const single = parseWinInetProxy(`
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:7890
    ProxyOverride    REG_SZ    localhost;127.*;<local>
`);
    expect(single).toMatchObject({
      url: "http://127.0.0.1:7890",
      bypass: ["localhost", "127.*", "<local>"],
      pacOnly: false,
      source: "os",
    });

    const perScheme = parseWinInetProxy(`
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    socks=127.0.0.1:10808
`);
    expect(perScheme).toMatchObject({ url: "socks5h://127.0.0.1:10808", source: "os" });

    const disabled = parseWinInetProxy(`
    ProxyEnable    REG_DWORD    0x0
    ProxyServer    REG_SZ    127.0.0.1:7890
    AutoConfigURL    REG_SZ    http://127.0.0.1:8000/pac
`);
    expect(disabled).toMatchObject({ url: null, pacOnly: true, source: "none" });
  });

  it("falls back to shell environment variables when OS proxy is unset", async () => {
    const info = await detectSystemProxy({
      platform: "darwin",
      exec: async () => "<dictionary> { HTTPEnable : 0\n HTTPSEnable : 0\n SOCKSEnable : 0\n }",
      env: { https_proxy: "http://127.0.0.1:8118", no_proxy: "localhost,10.0.0.0/8" },
    });
    expect(info).toMatchObject({
      url: "http://127.0.0.1:8118",
      bypass: ["localhost", "10.0.0.0/8"],
      source: "env",
    });
    expect(parseEnvProxy({ ALL_PROXY: "socks5://127.0.0.1:1080" })).toMatchObject({
      url: "socks5://127.0.0.1:1080",
      source: "env",
    });
  });
});

describe("DynamicProxyDispatcher and testProxyConnection", () => {
  it("routes fetch and WebSocket through HTTP proxy, bypasses loopback, and hot-switches to direct", async () => {
    const hits: string[] = [];
    const proxyServer = http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ proxied: true, url: req.url }));
    });
    proxyServer.on("connect", (req, socket) => {
      hits.push(`CONNECT ${req.url}`);
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    const proxyPort = await listenServer(proxyServer);
    cleanups.push(() => new Promise<void>((r) => proxyServer.close(() => r())));

    const localTarget = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ direct: true }));
    });
    const localPort = await listenServer(localTarget);
    cleanups.push(() => new Promise<void>((r) => localTarget.close(() => r())));

    const controller = installNetworkProxy();
    cleanups.push(() => controller.restore());

    controller.apply({
      url: `http://127.0.0.1:${proxyPort}`,
      displayUrl: `http://127.0.0.1:${proxyPort}`,
      bypass: ["bypassed.example"],
      source: "manual",
    });

    // External HTTP goes through the proxy.
    const proxied = await fetch("http://external.example/hello").then((r) => r.json());
    expect(proxied).toEqual({ proxied: true, url: "http://external.example/hello" });

    // Loopback ALWAYS bypasses the proxy.
    const loopback = await fetch(`http://127.0.0.1:${localPort}/health`).then((r) => r.json());
    expect(loopback).toEqual({ direct: true });

    // WebSocket (wss://) goes through HTTP CONNECT on the proxy.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000);
      const ws = new WebSocket("wss://gateway.example/ws");
      ws.onerror = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onclose = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    expect(hits).toContain("CONNECT gateway.example:443");

    // Hot-switch to off (direct): proxy is no longer hit.
    hits.length = 0;
    controller.apply(null);
    const stillLocal = await fetch(`http://127.0.0.1:${localPort}/health`).then((r) => r.json());
    expect(stillLocal).toEqual({ direct: true });
    expect(hits).toEqual([]);
  });

  it("tunnels fetch through SOCKS5 with RFC 1929 auth and tests proxy connectivity", async () => {
    const socks = await startMockSocks5({ auth: { user: "mingle", pass: "secret42" } });
    const controller = installNetworkProxy();
    cleanups.push(() => controller.restore());

    controller.apply({
      url: `socks5://mingle:secret42@127.0.0.1:${socks.port}`,
      displayUrl: `socks5://••••••@127.0.0.1:${socks.port}`,
      bypass: [],
      source: "manual",
    });

    const body = await fetch("http://echo.test/ping").then((r) => r.json());
    expect(body).toEqual({ via: "socks5", host: "echo.test", port: 80 });
    expect(socks.targets).toContainEqual({ host: "echo.test", port: 80 });

    // Connectivity tester validates credentials and rejects wrong passwords.
    const ok = await testProxyConnection(`socks5://mingle:secret42@127.0.0.1:${socks.port}`);
    expect(ok).toMatchObject({ ok: true });
    const badAuth = await testProxyConnection(`socks5://mingle:wrong@127.0.0.1:${socks.port}`);
    expect(badAuth).toEqual({ ok: false, code: "proxy_auth_failed" });

    // Unreachable port reports proxy_unreachable.
    const closed = net.createServer();
    const deadPort = await listenServer(closed);
    await new Promise<void>((r) => closed.close(() => r()));
    const unreachable = await testProxyConnection(`http://127.0.0.1:${deadPort}`, 1000);
    expect(unreachable).toEqual({ ok: false, code: "proxy_unreachable" });
  });
});

describe("harness proxy env precedence", () => {
  it("respects mode, passToHarness, and shell fallback rules", () => {
    const resolved = {
      url: "http://127.0.0.1:7890",
      displayUrl: "http://127.0.0.1:7890",
      bypass: ["*.local"],
      source: "os" as const,
    };

    // System mode injects OS proxy when shell has none.
    const fromOs = buildHarnessProxyEnv(resolved, { mode: "system", passToHarness: true, shellEnv: {} });
    expect(fromOs.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(fromOs.NO_PROXY).toContain("127.0.0.1");
    expect(fromOs.NO_PROXY).toContain("*.local");

    // System mode never clobbers shell proxy variables.
    const keepShell = buildHarnessProxyEnv(resolved, {
      mode: "system",
      passToHarness: true,
      shellEnv: { HTTPS_PROXY: "http://127.0.0.1:8118" },
    });
    expect(keepShell).toEqual({});

    // Manual mode overrides shell proxy variables.
    const manual = buildHarnessProxyEnv(
      { ...resolved, source: "manual" },
      { mode: "manual", passToHarness: true, shellEnv: { HTTPS_PROXY: "http://127.0.0.1:8118" } },
    );
    expect(manual.HTTPS_PROXY).toBe("http://127.0.0.1:7890");

    // Disabled or off injects nothing.
    expect(buildHarnessProxyEnv(resolved, { mode: "off", passToHarness: true, shellEnv: {} })).toEqual({});
    expect(buildHarnessProxyEnv(resolved, { mode: "manual", passToHarness: false, shellEnv: {} })).toEqual({});
  });
});

describe("admin proxy API and Mingle integration", () => {
  it("persists settings, keeps credentials only in Keychain, masks API/logs, and passes proxy to harness", async () => {
    const secrets = memorySecrets();
    const logs: string[] = [];
    const seenEnvs: Record<string, string>[] = [];
    const applied: (string | null)[] = [];
    const fakeProxy = {
      dispatcher: new DynamicProxyDispatcher(),
      httpsAgent: {} as ReturnType<typeof installNetworkProxy>["httpsAgent"],
      apply: (resolved: { url: string } | null) => {
        applied.push(resolved?.url ?? null);
      },
      restore: () => {},
    };

    current = await rig(
      async (t: ScriptedTurn) => {
        const env = { ...(t.options.env as Record<string, string>) };
        seenEnvs.push(env);
        for (const id of messageIds(t.input)) {
          await runCliNode(env, ["message", "reply", id], "ok");
        }
      },
      {
        secrets,
        log: (line) => logs.push(line),
        proxy: fakeProxy,
        detectSystemProxy: async () => ({
          url: "http://127.0.0.1:7890",
          httpUrl: "http://127.0.0.1:7890",
          httpsUrl: "http://127.0.0.1:7890",
          socksUrl: null,
          bypass: ["*.local"],
          pacOnly: false,
          source: "os",
        }),
        testProxy: async (url) =>
          url.includes("s3cr3tPass") ? { ok: true, latencyMs: 12 } : { ok: false, code: "proxy_auth_failed" },
      },
    );

    // Default mode is system and detected the OS proxy on start.
    const initial = await current.admin("GET", "/v1/admin/proxy");
    expect(initial.status).toBe(200);
    expect(initial.json).toMatchObject({
      mode: "system",
      url: null,
      hasAuth: false,
      passToHarness: true,
      effective: { url: "http://127.0.0.1:7890", source: "os", pacOnly: false },
    });
    expect(applied.at(-1)).toBe("http://127.0.0.1:7890");

    // Save authenticated manual proxy: credentials stay out of SQLite, API, and logs.
    const put = await current.admin("PUT", "/v1/admin/proxy", {
      mode: "manual",
      url: "socks5://alice:s3cr3tPass@127.0.0.1:1080",
      bypass: "corp.internal",
    });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({
      mode: "manual",
      url: "socks5://••••••@127.0.0.1:1080",
      hasAuth: true,
      authMissing: false,
      bypass: "corp.internal",
      effective: { url: "socks5://••••••@127.0.0.1:1080", source: "manual", pacOnly: false },
    });
    expect(JSON.stringify(put.json)).not.toContain("s3cr3tPass");
    expect(logs.join("\n")).not.toContain("s3cr3tPass");

    const storedAuth = await secrets.get(PROXY_AUTH_KEY);
    expect(decodeProxyAuth(storedAuth ?? "")).toEqual({ username: "alice", password: "s3cr3tPass" });

    // SQLite never contains the password.
    const { db } = current.mingle.options.paths;
    for (const file of [db, `${db}-wal`].filter((f) => existsSync(f))) {
      expect(readFileSync(file).includes("s3cr3tPass")).toBe(false);
    }

    // Testing the saved proxy reconstructs credentials in memory.
    const tested = await current.admin("POST", "/v1/admin/proxy/test", { useSaved: true });
    expect(tested).toEqual({ status: 200, json: { ok: true, latencyMs: 12 } });

    // Updating only bypass with keepAuth preserves stored credentials.
    const updatedBypass = await current.admin("PUT", "/v1/admin/proxy", {
      mode: "manual",
      url: "socks5://127.0.0.1:1080",
      keepAuth: true,
      bypass: "corp.internal, *.local",
    });
    expect(updatedBypass.status).toBe(200);
    expect(updatedBypass.json).toMatchObject({ hasAuth: true, bypass: "corp.internal, *.local" });
    expect(applied.at(-1)).toBe("socks5://alice:s3cr3tPass@127.0.0.1:1080");

    // Deliver a message so the scripted harness receives the manual proxy env.
    current.channel.receive({ text: "hello" });
    await until(() => current?.channel.sent[0]);
    await until(() => current?.mingle.runtime(current.agentId)?.busy === false);
    expect(seenEnvs[0]?.HTTPS_PROXY).toBe("socks5://alice:s3cr3tPass@127.0.0.1:1080");
    expect(seenEnvs[0]?.NO_PROXY).toContain("corp.internal");
    expect(seenEnvs[0]?.NO_PROXY).toContain("127.0.0.1");

    // Agent's own env var overrides Mingle's global manual proxy.
    await current.admin("PUT", `/v1/admin/agents/${current.agentId}/env/HTTPS_PROXY`, {
      value: "http://agent-only.local:9000",
    });
    current.channel.receive({ text: "hello again" });
    await until(() => current?.channel.sent[1]);
    expect(seenEnvs[1]?.HTTPS_PROXY).toBe("http://agent-only.local:9000");

    // Switching to off clears active proxy and passes direct to network controller.
    const off = await current.admin("PUT", "/v1/admin/proxy", { mode: "off" });
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({ mode: "off", effective: { url: null, source: "none" } });
    expect(applied.at(-1)).toBeNull();
  });

  it("migrates legacy mingle:proxy secret into proxy_settings and proxy:auth on startup", async () => {
    const secrets = memorySecrets();
    await secrets.set("mingle:proxy", "http://bob:legacyPass@127.0.0.1:7890");
    current = await rig(async () => {}, { secrets });

    const view = await current.admin("GET", "/v1/admin/proxy");
    expect(view.status).toBe(200);
    expect(view.json).toMatchObject({
      mode: "manual",
      url: "http://••••••@127.0.0.1:7890",
      hasAuth: true,
      authMissing: false,
      effective: { url: "http://••••••@127.0.0.1:7890", source: "manual" },
    });
    expect(await secrets.get("mingle:proxy")).toBeUndefined();
    expect(decodeProxyAuth((await secrets.get(PROXY_AUTH_KEY)) ?? "")).toEqual({
      username: "bob",
      password: "legacyPass",
    });
  });
});
