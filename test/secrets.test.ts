import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { linuxSecrets, windowsSecrets } from "../src/platform/secrets.ts";

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
