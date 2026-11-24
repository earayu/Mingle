import { afterEach, describe, expect, it } from "vitest";
import { MingleError } from "../src/core/errors.ts";
import {
  createProxyController,
  hasProxyCredentials,
  mergeNoProxy,
  PROXY_SECRET_REF,
  type ProxyConfig,
  parseMacSystemProxy,
  parseProxyUrl,
  parseWindowsSystemProxy,
  redactProxyUrl,
} from "../src/platform/proxy.ts";
import { memorySecrets } from "../src/platform/secrets.ts";
import { type Rig, rig, until } from "./helpers.ts";

describe("proxy parsing and redaction", () => {
  it("normalizes HTTP/HTTPS proxy URLs and rejects unsupported schemes", () => {
    expect(parseProxyUrl(null)).toBeNull();
    expect(parseProxyUrl("")).toBeNull();
    expect(parseProxyUrl("   ")).toBeNull();
    expect(parseProxyUrl("127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
    expect(parseProxyUrl("http://127.0.0.1:7890/")).toBe("http://127.0.0.1:7890");
    expect(parseProxyUrl("https://user:pass@proxy.example.com:8443/")).toBe("https://user:pass@proxy.example.com:8443");

    expect(() => parseProxyUrl("socks5://127.0.0.1:1080")).toThrow(MingleError);
    try {
      parseProxyUrl("socks5://127.0.0.1:1080");
    } catch (error) {
      expect((error as MingleError).code).toBe("proxy_unsupported_scheme");
    }

    try {
      parseProxyUrl("http://:bad");
    } catch (error) {
      expect((error as MingleError).code).toBe("proxy_invalid");
    }
  });

  it("redacts embedded credentials and detects when they are present", () => {
    expect(redactProxyUrl("http://alice:s3cret@127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
    expect(hasProxyCredentials("http://alice:s3cret@127.0.0.1:7890")).toBe(true);
    expect(hasProxyCredentials("http://127.0.0.1:7890")).toBe(false);
    expect(hasProxyCredentials(null)).toBe(false);
  });

  it("always keeps loopback hosts in NO_PROXY", () => {
    expect(mergeNoProxy(undefined)).toBe("127.0.0.1,localhost,::1");
    expect(mergeNoProxy("localhost, *.local; <local>, 10.0.0.0/8")).toBe("127.0.0.1,localhost,::1,*.local,10.0.0.0/8");
  });

  it("parses macOS scutil --proxy output", () => {
    const enabled = `
<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : *.local
    2 : 169.254/16
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
`;
    expect(parseMacSystemProxy(enabled)).toEqual({
      httpProxy: "http://127.0.0.1:7890",
      httpsProxy: "http://127.0.0.1:7890",
      noProxy: "127.0.0.1,*.local,169.254/16",
    });

    const disabled = `
<dictionary> {
  HTTPEnable : 0
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 0
}
`;
    expect(parseMacSystemProxy(disabled)).toBeUndefined();
  });

  it("parses Windows registry Internet Settings output", () => {
    const single = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:7890
    ProxyOverride    REG_SZ    localhost;127.*;<local>
`;
    expect(parseWindowsSystemProxy(single)).toEqual({
      httpProxy: "http://127.0.0.1:7890",
      httpsProxy: "http://127.0.0.1:7890",
      noProxy: "localhost;127.*;<local>",
    });

    const perScheme = `
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=127.0.0.1:8080;https=127.0.0.1:8443;socks=127.0.0.1:1080
`;
    expect(parseWindowsSystemProxy(perScheme)).toEqual({
      httpProxy: "http://127.0.0.1:8080",
      httpsProxy: "http://127.0.0.1:8443",
    });

    const off = `
    ProxyEnable    REG_DWORD    0x0
    ProxyServer    REG_SZ    127.0.0.1:7890
`;
    expect(parseWindowsSystemProxy(off)).toBeUndefined();
  });
});

describe("proxy controller priority", () => {
  it("resolves manual > env > system > none and restores baseline env when cleared", async () => {
    const env: Record<string, string | undefined> = { HTTPS_PROXY: "http://127.0.0.1:8118" };
    let system: ProxyConfig | undefined = { httpsProxy: "http://127.0.0.1:7890" };
    const applied: (ProxyConfig | undefined)[] = [];
    const controller = createProxyController({
      applyGlobal: true,
      env,
      readSystem: async () => system,
      setDispatcher: (config) => applied.push(config),
    });

    // Env takes precedence over system proxy.
    expect(await controller.apply(null)).toEqual({
      configured: null,
      hasCredentials: false,
      effective: "http://127.0.0.1:8118",
      source: "env",
    });

    // Manual overrides env and updates process.env for SDK clients, keeping loopback in NO_PROXY.
    expect(await controller.apply("http://user:pw@127.0.0.1:9000")).toEqual({
      configured: "http://127.0.0.1:9000",
      hasCredentials: true,
      effective: "http://127.0.0.1:9000",
      source: "manual",
    });
    expect(env.HTTPS_PROXY).toBe("http://user:pw@127.0.0.1:9000");
    expect(env.NO_PROXY).toContain("127.0.0.1");

    // Clearing manual restores the original env.
    expect(await controller.apply(null)).toEqual({
      configured: null,
      hasCredentials: false,
      effective: "http://127.0.0.1:8118",
      source: "env",
    });
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:8118");
    expect(env.HTTP_PROXY).toBeUndefined();

    // Without env, system proxy is adopted, synced to env for SDK clients, and cleared when disabled.
    const autoEnv: Record<string, string | undefined> = {};
    const auto = createProxyController({
      applyGlobal: true,
      env: autoEnv,
      readSystem: async () => system,
      setDispatcher: (config) => applied.push(config),
    });
    expect(await auto.refresh()).toEqual({
      configured: null,
      hasCredentials: false,
      effective: "http://127.0.0.1:7890",
      source: "system",
    });
    expect(autoEnv.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(autoEnv.NO_PROXY).toContain("127.0.0.1");
    system = undefined;
    expect(await auto.refresh()).toEqual({
      configured: null,
      hasCredentials: false,
      effective: null,
      source: "none",
    });
    expect(autoEnv.HTTPS_PROXY).toBeUndefined();
    expect(autoEnv.NO_PROXY).toBeUndefined();
  });
});

describe("admin proxy API", () => {
  let r: Rig | undefined;
  afterEach(async () => {
    await r?.close();
    r = undefined;
  });

  it("saves, redacts, clears, and reports proxy status in diagnostics", async () => {
    const secrets = memorySecrets();
    const logs: string[] = [];
    let system: ProxyConfig | undefined = { httpsProxy: "http://127.0.0.1:7890" };
    const proxy = createProxyController({
      applyGlobal: false,
      env: {},
      readSystem: async () => system,
      log: (line) => logs.push(line),
    });
    r = await rig(async () => {}, { secrets, proxy, log: (line) => logs.push(line) });

    // Automatic mode picks up the system proxy.
    const initial = await r.admin("GET", "/v1/admin/proxy");
    expect(initial.status).toBe(200);
    expect(initial.json).toEqual({
      configured: null,
      hasCredentials: false,
      effective: "http://127.0.0.1:7890",
      source: "system",
    });

    // Rejects unsupported schemes and invalid addresses with structured error codes.
    const socks = await r.admin("PUT", "/v1/admin/proxy", { url: "socks5://127.0.0.1:1080" });
    expect(socks.status).toBe(400);
    expect(socks.json).toMatchObject({ error: "proxy_unsupported_scheme" });

    // Saves manual proxy in the secret store and redacts credentials in responses, logs, and diagnostics.
    const saved = await r.admin("PUT", "/v1/admin/proxy", { url: "http://alice:topsecret@127.0.0.1:8888" });
    expect(saved.status).toBe(200);
    expect(saved.json).toEqual({
      configured: "http://127.0.0.1:8888",
      hasCredentials: true,
      effective: "http://127.0.0.1:8888",
      source: "manual",
    });
    expect(await secrets.get(PROXY_SECRET_REF)).toBe("http://alice:topsecret@127.0.0.1:8888");
    expect(logs.join("\n")).not.toContain("topsecret");

    const info = await r.mingle.diagnostics(r.agentId);
    expect(info).toContain("proxy: manual (http://127.0.0.1:8888)");
    expect(info).not.toContain("topsecret");

    // Clearing removes the saved secret and falls back to automatic (direct once system proxy is off).
    system = undefined;
    const cleared = await r.admin("PUT", "/v1/admin/proxy", { url: null });
    expect(cleared.status).toBe(200);
    expect(cleared.json).toEqual({
      configured: null,
      hasCredentials: false,
      effective: null,
      source: "none",
    });
    expect(await secrets.get(PROXY_SECRET_REF)).toBeUndefined();
  });

  it("nudges offline bots to reconnect when a proxy is configured", async () => {
    r = await rig(async () => {});
    const before = r.channel.connects;
    // Drop the bot with a network failure while connect attempts keep failing so it waits offline.
    r.channel.connectFailures = 100;
    r.channel.report({ kind: "error", code: "network" });
    await until(() => r?.mingle.store.connections(r.agentId).some((c) => c.state === "error"), 2000);
    r.channel.connectFailures = 0;

    const updated = await r.admin("PUT", "/v1/admin/proxy", { url: "http://127.0.0.1:7890" });
    expect(updated.status).toBe(200);
    await until(() => (r?.channel.connects ?? 0) > before, 2000);
    await until(() => r?.mingle.store.connections(r.agentId).some((c) => c.state === "connected"), 2000);
  });
});
