import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keychainSecrets, linuxSecrets, windowsSecrets } from "../src/platform/secrets.ts";

const tempFile = () => join(mkdtempSync(join(tmpdir(), "mingle-secrets-")), "secrets.json");

describe("windows secrets", () => {
  it("stores DPAPI output, never the plain value, and reads it back", async () => {
    // A stand-in for DPAPI: reversible, but visibly not the input.
    const calls: string[] = [];
    const run = async (_file: string, args: string[], stdin: string) => {
      const op = (args.at(-1) ?? "").includes("::Protect(") ? "protect" : "unprotect";
      calls.push(op);
      const bytes = Buffer.from(stdin, "base64");
      return { code: 0, stdout: Buffer.from(bytes.map((b) => b ^ 0x5a)).toString("base64") };
    };
    const path = tempFile();
    const store = windowsSecrets(path, run);
    await store.set("c1", '{"token":"s3cret"}');
    expect(readFileSync(path, "utf8")).not.toContain("s3cret");
    expect(await windowsSecrets(path, run).get("c1")).toBe('{"token":"s3cret"}');
    expect(calls).toEqual(["protect", "unprotect"]);
    await store.delete("c1");
    expect(await store.get("c1")).toBeUndefined();
  });
});

describe("linux secrets", () => {
  it("uses the Secret Service when it works", async () => {
    const keyring = new Map<string, string>();
    const run = async (_file: string, args: string[], stdin: string) => {
      const ref = args.at(-1) as string;
      if (args[0] === "store") keyring.set(ref, stdin);
      if (args[0] === "clear") keyring.delete(ref);
      if (args[0] === "lookup")
        return keyring.has(ref) ? { code: 0, stdout: keyring.get(ref) as string } : { code: 1, stdout: "" };
      return { code: 0, stdout: "" };
    };
    const path = tempFile();
    const store = linuxSecrets(path, run);
    await store.set("c1", "v1");
    expect(keyring.get("c1")).toBe("v1");
    expect(await store.get("c1")).toBe("v1");
    expect(keyring.has("__mingle_probe__")).toBe(false);
  });

  it("falls back to a 0600 file without one", async () => {
    const run = async () => ({ code: 1, stdout: "" });
    const path = tempFile();
    const store = linuxSecrets(path, run);
    await store.set("c1", "v1");
    expect(await store.get("c1")).toBe("v1");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ c1: "v1" });
  });
});

/**
 * A stand-in for /usr/bin/security that behaves like the real one where it matters: `-i`
 * reads commands from stdin (at most 4095 characters a line), and `find-generic-password -w`
 * prints a value that is not printable ASCII as hex.
 */
function fakeSecurity() {
  const items = new Map<string, string>();
  const argvs: string[][] = [];
  const parse = (line: string) => [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? "");
  const exec = (args: string[]) => {
    const flag = (name: string) => args[args.indexOf(name) + 1] ?? "";
    const key = `${flag("-s")}/${flag("-a")}`;
    if (args[0] === "add-generic-password") items.set(key, flag("-w"));
    if (args[0] === "delete-generic-password") return items.delete(key) ? 0 : 44;
    if (args[0] === "find-generic-password") {
      const value = items.get(key);
      if (value === undefined) return { code: 44, stdout: "" };
      const printable = /^[\x20-\x7e]*$/.test(value);
      return { code: 0, stdout: `${printable ? value : Buffer.from(value).toString("hex")}\n` };
    }
    return 0;
  };
  const run = async (_file: string, args: string[], stdin: string) => {
    argvs.push(args);
    if (args[0] !== "-i") return exec(args) as { code: number; stdout: string };
    let code = 0;
    for (const line of stdin.split("\n").filter(Boolean)) {
      if (line.length > 4095) throw new Error("command line too long for security -i");
      if (exec(parse(line)) !== 0) code = 44;
    }
    return { code, stdout: "" };
  };
  return { run, items, argvs };
}

describe("macOS keychain secrets", () => {
  const long = JSON.stringify({ token: "t".repeat(400), baseUrl: "https://example.com", name: "嘟嘟" });

  it("reads back long and non-ASCII values in full, never passing them in argv", async () => {
    const security = fakeSecurity();
    const store = keychainSecrets(security.run);
    await store.set("wechat:bot@im.bot", long);
    expect(await keychainSecrets(security.run).get("wechat:bot@im.bot")).toBe(long);
    expect(security.argvs.flat().join(" ")).not.toContain("tttt");
  });

  it("splits values longer than one command line and cleans up the parts", async () => {
    const security = fakeSecurity();
    const store = keychainSecrets(security.run);
    const pem = JSON.stringify(`-----BEGIN KEY-----\n${"k".repeat(30_000)}\n-----END KEY-----`);
    await store.set("env:a:KEY", pem);
    expect(security.items.size).toBeGreaterThan(2);
    expect(await store.get("env:a:KEY")).toBe(pem);
    await store.set("env:a:KEY", '"short"');
    expect(await store.get("env:a:KEY")).toBe('"short"');
    expect(security.items.size).toBe(1);
    await store.delete("env:a:KEY");
    expect(security.items.size).toBe(0);
    expect(await store.get("env:a:KEY")).toBeUndefined();
  });

  it("still reads values saved the old way, hex-printed when not ASCII", async () => {
    const security = fakeSecurity();
    security.items.set("app.mingle/c1", '{"token":"plain"}');
    security.items.set("app.mingle/c2", '{"name":"嘟嘟"}');
    const store = keychainSecrets(security.run);
    expect(await store.get("c1")).toBe('{"token":"plain"}');
    expect(await store.get("c2")).toBe('{"name":"嘟嘟"}');
  });

  it("fails the write when the value does not read back", async () => {
    const security = fakeSecurity();
    const run = async (file: string, args: string[], stdin: string) =>
      args[0] === "-i" ? { code: 1, stdout: "" } : security.run(file, args, stdin);
    await expect(keychainSecrets(run).set("c1", long)).rejects.toThrow(/Keychain/);
  });

  // The real Keychain, under a throwaway service name. Skipped on CI, where it may prompt.
  it.runIf(process.platform === "darwin" && !process.env.CI)("round-trips through the real Keychain", async () => {
    const store = keychainSecrets(undefined, `app.mingle.test.${process.pid}`);
    const pem = JSON.stringify("p".repeat(9000));
    try {
      await store.set("c1", long);
      expect(await store.get("c1")).toBe(long);
      await store.set("c2", pem);
      expect(await store.get("c2")).toBe(pem);
    } finally {
      await store.delete("c1");
      await store.delete("c2");
    }
    expect(await store.get("c1")).toBeUndefined();
    expect(await store.get("c2")).toBeUndefined();
  });
});
