import { execFile } from "node:child_process";
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { MingleError } from "../core/errors.ts";

/** Secret-store reference for a manual proxy URL configured in Settings. */
export const PROXY_SECRET_REF = "mingle:proxy";

/** Loopback addresses that must never go through a proxy (Mingle's local API and SSH tunnels). */
const LOCAL_NO_PROXY = ["127.0.0.1", "localhost", "::1"] as const;

export type ProxySource = "manual" | "env" | "system" | "none";

export interface ProxyConfig {
  readonly httpProxy?: string;
  readonly httpsProxy?: string;
  readonly noProxy?: string;
}

export interface ProxyStatus {
  /** Manually configured proxy URL with any credentials stripped, or null when automatic. */
  readonly configured: string | null;
  /** True when the manually configured URL includes a username or password. */
  readonly hasCredentials: boolean;
  /** Currently active proxy URL (redacted), or null when connecting directly. */
  readonly effective: string | null;
  readonly source: ProxySource;
}

/**
 * Validate and normalize a proxy URL from the user or an environment variable.
 * Empty input returns null (clear / automatic). Bare `host:port` defaults to `http://`.
 * Only HTTP/HTTPS proxies are supported by Node's undici dispatcher.
 */
export function parseProxyUrl(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const withScheme = trimmed.includes("://") ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new MingleError("proxy_invalid", "enter an HTTP proxy address such as http://127.0.0.1:7890");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MingleError(
      "proxy_unsupported_scheme",
      "use your proxy tool's HTTP proxy address (such as http://127.0.0.1:7890); SOCKS URLs are not supported directly",
    );
  }
  if (!url.hostname) {
    throw new MingleError("proxy_invalid", "enter an HTTP proxy address such as http://127.0.0.1:7890");
  }
  return url.toString().replace(/\/$/, "");
}

/** Best-effort parse for env/system values: returns undefined instead of throwing. */
function safeHttpProxy(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  try {
    return parseProxyUrl(raw) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Strip username and password from a proxy URL so secrets never enter logs or API responses. */
export function redactProxyUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

/** True when a proxy URL embeds a username or password. */
export function hasProxyCredentials(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}

/** Combine NO_PROXY lists and ensure loopback addresses always bypass the proxy. */
export function mergeNoProxy(...lists: readonly (string | undefined)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (entry: string) => {
    const clean = entry.trim();
    if (!clean || clean === "<local>") return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(clean);
  };
  for (const host of LOCAL_NO_PROXY) add(host);
  for (const list of lists) {
    if (!list) continue;
    for (const part of list.split(/[,\s;]+/)) add(part);
  }
  return out.join(",");
}

/** Read HTTP/HTTPS proxy settings from environment variables. */
export function readEnvProxy(env: Readonly<Record<string, string | undefined>>): ProxyConfig | undefined {
  const httpProxy = safeHttpProxy(env.HTTP_PROXY || env.http_proxy);
  const httpsProxy = safeHttpProxy(env.HTTPS_PROXY || env.https_proxy);
  if (!httpProxy && !httpsProxy) return undefined;
  const noProxy = env.NO_PROXY || env.no_proxy || undefined;
  return {
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(noProxy ? { noProxy } : {}),
  };
}

function formatHostPort(host: string, port: string): string {
  const cleanHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${cleanHost}:${port}`;
}

/** Parse macOS `scutil --proxy` output into an HTTP/HTTPS proxy config. */
export function parseMacSystemProxy(output: string): ProxyConfig | undefined {
  const scalars = new Map<string, string>();
  const exceptions: string[] = [];
  let inExceptions = false;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (inExceptions) {
      if (trimmed === "}") {
        inExceptions = false;
        continue;
      }
      const item = /^\d+\s*:\s*(.+)$/.exec(trimmed);
      if (item?.[1]) exceptions.push(item[1].trim());
      continue;
    }
    if (/^ExceptionsList\s*:\s*<array>\s*\{/.test(trimmed)) {
      inExceptions = true;
      continue;
    }
    const pair = /^([A-Za-z0-9_]+)\s*:\s*(.+)$/.exec(trimmed);
    if (pair?.[1] && pair[2]) scalars.set(pair[1], pair[2].trim());
  }
  const httpProxy =
    scalars.get("HTTPEnable") === "1" && scalars.get("HTTPProxy") && scalars.get("HTTPPort")
      ? safeHttpProxy(formatHostPort(scalars.get("HTTPProxy") as string, scalars.get("HTTPPort") as string))
      : undefined;
  const httpsProxy =
    scalars.get("HTTPSEnable") === "1" && scalars.get("HTTPSProxy") && scalars.get("HTTPSPort")
      ? safeHttpProxy(formatHostPort(scalars.get("HTTPSProxy") as string, scalars.get("HTTPSPort") as string))
      : undefined;
  if (!httpProxy && !httpsProxy) return undefined;
  return {
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(exceptions.length ? { noProxy: exceptions.join(",") } : {}),
  };
}

/** Parse Windows `reg query "HKCU\...\Internet Settings"` output into an HTTP/HTTPS proxy config. */
export function parseWindowsSystemProxy(output: string): ProxyConfig | undefined {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s+REG_[A-Z0-9_]+\s+(.+)$/.exec(line);
    if (match?.[1] && match[2]) values.set(match[1], match[2].trim());
  }
  const enabled = values.get("ProxyEnable");
  if (!enabled || (enabled !== "0x1" && enabled !== "1")) return undefined;
  const server = values.get("ProxyServer")?.trim();
  if (!server) return undefined;

  let httpProxy: string | undefined;
  let httpsProxy: string | undefined;
  if (server.includes("=")) {
    for (const part of server.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const scheme = part.slice(0, eq).trim().toLowerCase();
      const addr = part.slice(eq + 1).trim();
      if (scheme === "http") httpProxy = safeHttpProxy(addr);
      else if (scheme === "https") httpsProxy = safeHttpProxy(addr);
    }
  } else {
    const both = safeHttpProxy(server);
    httpProxy = both;
    httpsProxy = both;
  }
  if (!httpProxy && !httpsProxy) return undefined;
  const override = values.get("ProxyOverride");
  return {
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(override ? { noProxy: override } : {}),
  };
}

function runQuery(file: string, args: string[], timeoutMs = 2000): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      resolve(error ? undefined : stdout);
    });
    child.on("error", () => resolve(undefined));
  });
}

/** Read the operating system's HTTP/HTTPS proxy settings, if enabled. Never throws. */
export async function readSystemProxy(
  platform: NodeJS.Platform = process.platform,
  run: (file: string, args: string[]) => Promise<string | undefined> = runQuery,
): Promise<ProxyConfig | undefined> {
  if (platform === "darwin") {
    const out = await run("/usr/sbin/scutil", ["--proxy"]);
    return out ? parseMacSystemProxy(out) : undefined;
  }
  if (platform === "win32") {
    const out = await run("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"]);
    return out ? parseWindowsSystemProxy(out) : undefined;
  }
  return undefined;
}

const ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"] as const;

export interface ProxyController {
  readonly status: ProxyStatus;
  /** Apply manual (if set), else env, else OS system proxy. Returns the active status. */
  apply(manualUrl: string | null): Promise<ProxyStatus>;
  /** Re-read OS system proxy when running in automatic mode. */
  refresh(): Promise<ProxyStatus>;
}

export interface ProxyControllerOptions {
  /** Apply to Node's global undici dispatcher and process.env. False in unit tests by default. */
  readonly applyGlobal?: boolean;
  readonly env?: Record<string, string | undefined>;
  readonly readSystem?: () => Promise<ProxyConfig | undefined>;
  readonly setDispatcher?: (config: ProxyConfig | undefined) => void;
  readonly log?: (line: string) => void;
}

/**
 * Resolves and applies network proxy settings for Node's global `fetch` and `WebSocket`
 * (Telegram, Discord, Slack, GitHub, etc.) as well as `process.env` for SDK HTTP clients.
 *
 * Priority: manual setting in Mingle -> login-shell / process env -> OS system proxy -> direct.
 */
export function createProxyController(options: ProxyControllerOptions = {}): ProxyController {
  const applyGlobal = options.applyGlobal ?? false;
  const env = options.env ?? (applyGlobal ? process.env : {});
  const readSystem = options.readSystem ?? (applyGlobal ? () => readSystemProxy() : async () => undefined);
  const setDispatcher =
    options.setDispatcher ??
    ((config: ProxyConfig | undefined) => {
      if (!applyGlobal) return;
      if (config && (config.httpProxy || config.httpsProxy)) {
        setGlobalDispatcher(
          new EnvHttpProxyAgent({
            ...(config.httpProxy ? { httpProxy: config.httpProxy } : {}),
            ...(config.httpsProxy ? { httpsProxy: config.httpsProxy } : {}),
            noProxy: mergeNoProxy(config.noProxy),
          }),
        );
      } else {
        setGlobalDispatcher(new Agent());
      }
    });

  // Snapshot the process's initial proxy env once (after login-shell env has been adopted), so
  // clearing a manual proxy cleanly restores whatever the shell or user originally configured.
  const baseline: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  for (const key of ENV_KEYS) baseline[key] = env[key];

  let manual: string | null = null;
  let current: ProxyStatus = { configured: null, hasCredentials: false, effective: null, source: "none" };
  let lastLogged = "";

  const restoreEnv = () => {
    if (!applyGlobal) return;
    for (const key of ENV_KEYS) {
      const orig = baseline[key];
      if (orig === undefined) delete env[key];
      else env[key] = orig;
    }
  };

  const syncEnv = (config: ProxyConfig) => {
    if (!applyGlobal) return;
    if (config.httpProxy) {
      env.HTTP_PROXY = config.httpProxy;
      env.http_proxy = config.httpProxy;
    } else {
      delete env.HTTP_PROXY;
      delete env.http_proxy;
    }
    if (config.httpsProxy) {
      env.HTTPS_PROXY = config.httpsProxy;
      env.https_proxy = config.httpsProxy;
    } else {
      delete env.HTTPS_PROXY;
      delete env.https_proxy;
    }
    if (config.noProxy) {
      env.NO_PROXY = config.noProxy;
      env.no_proxy = config.noProxy;
    }
  };

  const resolveAndApply = async (): Promise<ProxyStatus> => {
    let source: ProxySource = "none";
    let active: ProxyConfig | undefined;

    if (manual) {
      source = "manual";
      const noProxy = mergeNoProxy(baseline.NO_PROXY, baseline.no_proxy);
      active = { httpProxy: manual, httpsProxy: manual, noProxy };
      syncEnv(active);
    } else {
      restoreEnv();
      const fromEnv = readEnvProxy(baseline);
      if (fromEnv) {
        source = "env";
        active = { ...fromEnv, noProxy: mergeNoProxy(fromEnv.noProxy) };
      } else {
        const fromSystem = await readSystem().catch(() => undefined);
        if (fromSystem) {
          source = "system";
          active = { ...fromSystem, noProxy: mergeNoProxy(baseline.NO_PROXY, baseline.no_proxy, fromSystem.noProxy) };
          syncEnv(active);
        }
      }
    }

    setDispatcher(active);
    const rawEffective = active?.httpsProxy ?? active?.httpProxy ?? null;
    current = {
      configured: manual ? redactProxyUrl(manual) : null,
      hasCredentials: hasProxyCredentials(manual),
      effective: rawEffective ? redactProxyUrl(rawEffective) : null,
      source,
    };

    const summary = `${current.source}:${current.effective ?? "direct"}`;
    if (summary !== lastLogged) {
      const hadPrev = lastLogged !== "";
      lastLogged = summary;
      if (current.effective) options.log?.(`network proxy: ${current.effective} (${current.source})`);
      else if (hadPrev) options.log?.("network proxy: direct");
    }
    return current;
  };

  return {
    get status() {
      return current;
    },
    async apply(manualUrl: string | null) {
      manual = parseProxyUrl(manualUrl);
      return resolveAndApply();
    },
    async refresh() {
      return resolveAndApply();
    },
  };
}
