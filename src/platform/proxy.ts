import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { MingleError } from "../core/errors.ts";

const execFileAsync = promisify(execFile);

/**
 * Network proxy configuration, URL parsing, bypass matching, and OS system proxy detection.
 *
 * Credentials (username/password) are stripped before persisting URLs to SQLite and kept only
 * in the system credential store under `PROXY_AUTH_KEY`. Neither logs nor API responses ever
 * include raw credentials.
 */

export type ProxyMode = "system" | "manual" | "off";

export interface ProxyAuth {
  readonly username: string;
  readonly password: string;
}

export interface ProxySettings {
  readonly mode: ProxyMode;
  /** Manual proxy URL without embedded credentials (e.g. `http://127.0.0.1:7890`). */
  readonly url: string | null;
  readonly hasAuth: boolean;
  /** Comma-separated bypass rules configured by the user. */
  readonly bypass: string;
  /** Pass the active proxy as default env vars to harness child processes. */
  readonly passToHarness: boolean;
  readonly updatedAt: number;
}

export interface SystemProxyInfo {
  readonly url: string | null;
  readonly httpUrl: string | null;
  readonly httpsUrl: string | null;
  readonly socksUrl: string | null;
  readonly bypass: readonly string[];
  /** True when the OS only has a PAC auto-config URL enabled without explicit proxy host/port. */
  readonly pacOnly: boolean;
  readonly source: "os" | "env" | "none";
}

export interface ResolvedProxy {
  /** Full proxy URL in memory (may contain credentials for transport; never log or return). */
  readonly url: string;
  /** Sanitized display URL with credentials masked as `••••••`. */
  readonly displayUrl: string;
  readonly bypass: readonly string[];
  readonly source: "os" | "env" | "manual";
}

export interface ParsedProxyUrl {
  readonly protocol: "http:" | "https:" | "socks5:" | "socks5h:";
  readonly hostname: string;
  readonly port: number;
  /** Normalized URL without username/password. */
  readonly cleanUrl: string;
  readonly auth: ProxyAuth | null;
}

export const PROXY_AUTH_KEY = "proxy:auth";

const SUPPORTED_PROTOCOLS = new Set(["http:", "https:", "socks5:", "socks5h:"]);
const DEFAULT_PORTS: Record<string, number> = {
  "http:": 80,
  "https:": 443,
  "socks5:": 1080,
  "socks5h:": 1080,
};

const PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

export const LOOPBACK_BYPASS = ["localhost", "127.0.0.1", "::1"] as const;

export function defaultProxySettings(): ProxySettings {
  return {
    mode: "system",
    url: null,
    hasAuth: false,
    bypass: "",
    passToHarness: true,
    updatedAt: 0,
  };
}

export function validateProxyMode(value: unknown): ProxyMode {
  if (value === "system" || value === "manual" || value === "off") return value;
  throw new MingleError("proxy_mode_invalid", "proxy mode must be system, manual, or off");
}

export function parseProxyUrl(raw: string): ParsedProxyUrl {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new MingleError("proxy_url_required", "enter a proxy URL such as http://127.0.0.1:7890");
  }
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) {
      throw new MingleError("proxy_url_invalid", "proxy URL cannot contain spaces or control characters");
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new MingleError("proxy_url_invalid", "enter a valid proxy URL such as http://127.0.0.1:7890");
  }
  const protocol = parsed.protocol.toLowerCase();
  if (!SUPPORTED_PROTOCOLS.has(protocol)) {
    throw new MingleError(
      "proxy_protocol_unsupported",
      "proxy protocol must be http://, https://, socks5://, or socks5h://",
    );
  }
  if (!parsed.hostname) {
    throw new MingleError("proxy_url_invalid", "proxy URL must include a host name or IP address");
  }
  const defaultPort = DEFAULT_PORTS[protocol] ?? 0;
  const port = parsed.port ? Number(parsed.port) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new MingleError("proxy_url_invalid", "proxy port must be between 1 and 65535");
  }
  const hasAuth = parsed.username.length > 0 || parsed.password.length > 0;
  const auth: ProxyAuth | null = hasAuth
    ? { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) }
    : null;
  const host =
    parsed.hostname.includes(":") && !parsed.hostname.startsWith("[") ? `[${parsed.hostname}]` : parsed.hostname;
  const cleanUrl = `${protocol}//${host}${parsed.port ? `:${parsed.port}` : ""}`;
  return {
    protocol: protocol as ParsedProxyUrl["protocol"],
    hostname: parsed.hostname.replace(/^\[|\]$/g, ""),
    port,
    cleanUrl,
    auth,
  };
}

export function maskProxyUrl(cleanUrl: string, hasAuth: boolean): string {
  if (!hasAuth) return cleanUrl;
  try {
    const parsed = new URL(cleanUrl);
    const host =
      parsed.hostname.includes(":") && !parsed.hostname.startsWith("[") ? `[${parsed.hostname}]` : parsed.hostname;
    return `${parsed.protocol}//••••••@${host}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return cleanUrl;
  }
}

export function maskRawProxyUrl(rawUrl: string): string {
  try {
    const parsed = parseProxyUrl(rawUrl);
    return maskProxyUrl(parsed.cleanUrl, parsed.auth !== null);
  } catch {
    return rawUrl.replace(/\/\/[^/@]+@/, "//••••••@");
  }
}

export function applyProxyAuth(cleanUrl: string, auth: ProxyAuth | null): string {
  if (!auth) return cleanUrl;
  const parsed = new URL(cleanUrl);
  parsed.username = auth.username;
  parsed.password = auth.password;
  return parsed.toString().replace(/\/$/, "");
}

export function encodeProxyAuth(auth: ProxyAuth): string {
  return JSON.stringify({ username: auth.username, password: auth.password });
}

export function decodeProxyAuth(stored: string): ProxyAuth | null {
  try {
    const parsed = JSON.parse(stored) as { username?: unknown; password?: unknown };
    if (typeof parsed.username === "string" && typeof parsed.password === "string") {
      return { username: parsed.username, password: parsed.password };
    }
  } catch {}
  return null;
}

export function parseBypassList(raw: string): string[] {
  return raw
    .split(/[,\n;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** True for loopback hosts that must never be routed through a proxy. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1" || host === "0.0.0.0") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  return false;
}

function parseIpv4(ip: string): number | null {
  if (isIP(ip) !== 4) return null;
  const [a, b, c, d] = ip.split(".").map(Number);
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  if ([a, b, c, d].some((n) => n < 0 || n > 255)) return null;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function matchCidr(host: string, rule: string): boolean {
  const slash = rule.indexOf("/");
  if (slash === -1) return false;
  const baseIp = parseIpv4(rule.slice(0, slash));
  const prefix = Number(rule.slice(slash + 1));
  const hostIp = parseIpv4(host);
  if (baseIp === null || hostIp === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (hostIp & mask) === (baseIp & mask);
}

/**
 * Checks whether a target host (and optional port) should bypass the proxy.
 * Loopback addresses always bypass regardless of user configuration.
 */
export function shouldBypass(
  hostname: string,
  port: number | string | undefined,
  bypassRules: readonly string[],
): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!host || isLoopbackHost(host)) return true;
  const targetPort = port !== undefined && port !== "" ? String(port) : "";

  for (const rawRule of bypassRules) {
    const rule = rawRule.trim().toLowerCase();
    if (!rule) continue;
    if (rule === "*") return true;
    if (rule === "<local>") {
      if (!host.includes(".") && isIP(host) === 0) return true;
      continue;
    }
    if (rule.includes("/") && matchCidr(host, rule)) return true;

    // Split optional host:port (ignoring bare IPv6 literals without brackets)
    let ruleHost = rule;
    let rulePort = "";
    const bracketPort = /^\[([^\]]+)\]:(\d+)$/.exec(rule);
    if (bracketPort?.[1] && bracketPort[2]) {
      ruleHost = bracketPort[1];
      rulePort = bracketPort[2];
    } else if (rule.startsWith("[") && rule.endsWith("]")) {
      ruleHost = rule.slice(1, -1);
    } else {
      const colonCount = (rule.match(/:/g) ?? []).length;
      if (colonCount === 1) {
        const idx = rule.indexOf(":");
        ruleHost = rule.slice(0, idx);
        rulePort = rule.slice(idx + 1);
      }
    }

    if (rulePort && targetPort && rulePort !== targetPort) continue;
    if (rulePort && !targetPort) continue;

    if (ruleHost.startsWith("*.")) {
      const suffix = ruleHost.slice(1); // ".example.com"
      const bare = ruleHost.slice(2);
      if (host === bare || host.endsWith(suffix)) return true;
      continue;
    }
    if (ruleHost.startsWith(".")) {
      const bare = ruleHost.slice(1);
      if (host === bare || host.endsWith(ruleHost)) return true;
      continue;
    }
    if (host === ruleHost || host.endsWith(`.${ruleHost}`)) return true;
  }
  return false;
}

/** Captures proxy-related variables from an environment record. */
export function captureShellProxyEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const captured: Record<string, string> = {};
  for (const key of PROXY_ENV_NAMES) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) captured[key] = value.trim();
  }
  return captured;
}

function normalizeCandidateUrl(raw: string | undefined, defaultScheme = "http"): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z0-9+.-]+:\/\//i.test(trimmed) ? trimmed : `${defaultScheme}://${trimmed}`;
  try {
    parseProxyUrl(withScheme);
    return withScheme;
  } catch {
    return null;
  }
}

/** Parses standard HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY environment variables. */
export function parseEnvProxy(env: Readonly<Record<string, string | undefined>>): SystemProxyInfo {
  const httpsUrl = normalizeCandidateUrl(env.HTTPS_PROXY ?? env.https_proxy);
  const httpUrl = normalizeCandidateUrl(env.HTTP_PROXY ?? env.http_proxy);
  const allUrl = normalizeCandidateUrl(env.ALL_PROXY ?? env.all_proxy, "socks5h");
  const socksUrl = allUrl && /^socks5h?:\/\//i.test(allUrl) ? allUrl : null;
  const url = httpsUrl ?? httpUrl ?? allUrl ?? null;
  const bypass = parseBypassList(env.NO_PROXY ?? env.no_proxy ?? "");
  return {
    url,
    httpUrl: httpUrl ?? (allUrl && !socksUrl ? allUrl : null),
    httpsUrl: httpsUrl ?? (allUrl && !socksUrl ? allUrl : null),
    socksUrl,
    bypass,
    pacOnly: false,
    source: url ? "env" : "none",
  };
}

/** Parses macOS `scutil --proxy` output. */
export function parseScutilProxy(stdout: string): SystemProxyInfo {
  const values = new Map<string, string>();
  const exceptions: string[] = [];
  let inExceptions = false;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (inExceptions) {
      if (line === "}") {
        inExceptions = false;
        continue;
      }
      const item = /^\d+\s*:\s*(.+)$/.exec(line);
      if (item?.[1]) exceptions.push(item[1].trim());
      continue;
    }
    if (/^ExceptionsList\s*:\s*<array>\s*\{$/.test(line)) {
      inExceptions = true;
      continue;
    }
    const kv = /^([A-Za-z0-9_]+)\s*:\s*(.+)$/.exec(line);
    if (kv?.[1] && kv[2]) values.set(kv[1], kv[2].trim());
  }

  const hostPort = (enableKey: string, hostKey: string, portKey: string, scheme: string): string | null => {
    if (values.get(enableKey) !== "1") return null;
    const host = values.get(hostKey);
    const port = values.get(portKey);
    if (!host || !port) return null;
    const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    return normalizeCandidateUrl(`${scheme}://${formattedHost}:${port}`);
  };

  const httpsUrl = hostPort("HTTPSEnable", "HTTPSProxy", "HTTPSPort", "http");
  const httpUrl = hostPort("HTTPEnable", "HTTPProxy", "HTTPPort", "http");
  const socksUrl = hostPort("SOCKSEnable", "SOCKSProxy", "SOCKSPort", "socks5h");
  const pacEnabled = values.get("ProxyAutoConfigEnable") === "1" && Boolean(values.get("ProxyAutoConfigURLString"));

  const url = httpsUrl ?? httpUrl ?? socksUrl ?? null;
  return {
    url,
    httpUrl,
    httpsUrl,
    socksUrl,
    bypass: exceptions,
    pacOnly: !url && pacEnabled,
    source: url ? "os" : "none",
  };
}

/** Parses Windows `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"` output. */
export function parseWinInetProxy(stdout: string): SystemProxyInfo {
  const values = new Map<string, string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s+REG_[A-Z0-9_]+\s+(.*)$/.exec(rawLine);
    if (match?.[1]) values.set(match[1].toLowerCase(), (match[2] ?? "").trim());
  }

  const enableRaw = values.get("proxyenable") ?? "0";
  const enabled = enableRaw === "0x1" || enableRaw === "1";
  const server = values.get("proxyserver") ?? "";
  const override = values.get("proxyoverride") ?? "";
  const autoConfig = values.get("autoconfigurl") ?? "";

  let httpUrl: string | null = null;
  let httpsUrl: string | null = null;
  let socksUrl: string | null = null;

  if (enabled && server) {
    if (server.includes("=")) {
      for (const part of server.split(";")) {
        const eq = part.indexOf("=");
        if (eq === -1) continue;
        const proto = part.slice(0, eq).trim().toLowerCase();
        const addr = part.slice(eq + 1).trim();
        if (proto === "http") httpUrl = normalizeCandidateUrl(addr, "http");
        else if (proto === "https") httpsUrl = normalizeCandidateUrl(addr, "http");
        else if (proto === "socks") socksUrl = normalizeCandidateUrl(addr, "socks5h");
      }
    } else {
      const single = normalizeCandidateUrl(server, "http");
      httpUrl = single;
      httpsUrl = single;
    }
  }

  const url = httpsUrl ?? httpUrl ?? socksUrl ?? null;
  const bypass = parseBypassList(override);
  return {
    url,
    httpUrl,
    httpsUrl,
    socksUrl,
    bypass,
    pacOnly: !url && Boolean(autoConfig),
    source: url ? "os" : "none",
  };
}

export interface DetectSystemProxyOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly exec?: (file: string, args: readonly string[]) => Promise<string>;
}

const defaultExec = async (file: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await execFileAsync(file, [...args], { timeout: 2000, windowsHide: true });
  return String(stdout);
};

/**
 * Detects the active system proxy on macOS, Windows, or Linux, falling back to shell
 * proxy environment variables when no OS-level proxy is configured.
 */
export async function detectSystemProxy(options: DetectSystemProxyOptions = {}): Promise<SystemProxyInfo> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exec = options.exec ?? defaultExec;
  let osInfo: SystemProxyInfo = {
    url: null,
    httpUrl: null,
    httpsUrl: null,
    socksUrl: null,
    bypass: [],
    pacOnly: false,
    source: "none",
  };

  if (platform === "darwin") {
    try {
      osInfo = parseScutilProxy(await exec("scutil", ["--proxy"]));
    } catch {}
  } else if (platform === "win32") {
    try {
      osInfo = parseWinInetProxy(
        await exec("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"]),
      );
    } catch {}
  }

  if (osInfo.url) return osInfo;
  const envInfo = parseEnvProxy(env);
  if (envInfo.url) return envInfo;
  return osInfo;
}

/**
 * Builds proxy environment variables to pass to harness child processes.
 * Precedence: MINGLE_* > agent_env > manual proxy > shell env > OS system proxy.
 */
export function buildHarnessProxyEnv(
  resolved: ResolvedProxy | null,
  options: {
    readonly mode: ProxyMode;
    readonly passToHarness: boolean;
    readonly shellEnv: Readonly<Record<string, string | undefined>>;
  },
): Record<string, string> {
  if (!options.passToHarness || options.mode === "off" || !resolved) return {};

  // In system mode, never clobber proxy variables the user explicitly set in their shell.
  if (options.mode === "system") {
    const shellAlreadyHas = Boolean(
      options.shellEnv.HTTPS_PROXY ||
        options.shellEnv.https_proxy ||
        options.shellEnv.HTTP_PROXY ||
        options.shellEnv.http_proxy ||
        options.shellEnv.ALL_PROXY ||
        options.shellEnv.all_proxy,
    );
    if (shellAlreadyHas) return {};
  }

  const bypass = [...new Set([...LOOPBACK_BYPASS, ...resolved.bypass])].join(",");
  const isSocks = /^socks5h?:\/\//i.test(resolved.url);
  if (isSocks) {
    return {
      ALL_PROXY: resolved.url,
      all_proxy: resolved.url,
      HTTPS_PROXY: resolved.url,
      https_proxy: resolved.url,
      HTTP_PROXY: resolved.url,
      http_proxy: resolved.url,
      NO_PROXY: bypass,
      no_proxy: bypass,
    };
  }
  return {
    HTTP_PROXY: resolved.url,
    http_proxy: resolved.url,
    HTTPS_PROXY: resolved.url,
    https_proxy: resolved.url,
    ALL_PROXY: resolved.url,
    all_proxy: resolved.url,
    NO_PROXY: bypass,
    no_proxy: bypass,
  };
}
