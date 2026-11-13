import { execFile } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/** Where IM credentials live. Never SQLite, never logs. */
export interface SecretStore {
  get(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

const SERVICE = "app.mingle";

function security(args: string[], stdin?: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile("/usr/bin/security", args, (error, stdout) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout });
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

/** macOS Keychain through /usr/bin/security. The secret goes in on stdin, so it never appears in argv. */
export function keychainSecrets(): SecretStore {
  return {
    async get(ref) {
      const { code, stdout } = await security(["find-generic-password", "-s", SERVICE, "-a", ref, "-w"]);
      return code === 0 ? stdout.replace(/\n$/, "") : undefined;
    },
    async set(ref, value) {
      // With -w last, security prompts for the password twice on stdin.
      const { code } = await security(
        ["add-generic-password", "-s", SERVICE, "-a", ref, "-U", "-w"],
        `${value}\n${value}\n`,
      );
      if (code !== 0) throw new Error("could not save the credentials to the Keychain");
    },
    async delete(ref) {
      await security(["delete-generic-password", "-s", SERVICE, "-a", ref]);
    },
  };
}

/** Runs a program with `stdin` and collects stdout. Never rejects. */
function runWith(
  file: string,
  args: string[],
  stdin: string,
  timeoutMs = 15_000,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      resolve({ code: error ? Number((error as { code?: unknown }).code) || 1 : 0, stdout });
    });
    child.on("error", () => resolve({ code: 127, stdout: "" }));
    child.stdin?.end(stdin);
  });
}

/**
 * Windows: values encrypted with DPAPI for the current user (what Credential Manager uses
 * underneath), kept in a JSON file. Only this Windows account can decrypt them.
 * PowerShell does the crypto, so there is no native module; reads are cached.
 */
export function windowsSecrets(path: string, run = runWith): SecretStore {
  const file = fileSecrets(path);
  const cache = new Map<string, string>();
  const dpapi = async (op: "Protect" | "Unprotect", base64: string) => {
    const script =
      "Add-Type -AssemblyName System.Security;" +
      "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());" +
      `$o=[Security.Cryptography.ProtectedData]::${op}($b,$null,'CurrentUser');` +
      "[Console]::Out.Write([Convert]::ToBase64String($o))";
    const { code, stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], base64);
    if (code !== 0) throw new Error(`could not ${op === "Protect" ? "encrypt" : "decrypt"} the credentials`);
    return stdout.trim();
  };
  return {
    async get(ref) {
      const cached = cache.get(ref);
      if (cached !== undefined) return cached;
      const sealed = await file.get(ref);
      if (sealed === undefined) return undefined;
      const value = Buffer.from(await dpapi("Unprotect", sealed), "base64").toString("utf8");
      cache.set(ref, value);
      return value;
    },
    async set(ref, value) {
      await file.set(ref, await dpapi("Protect", Buffer.from(value, "utf8").toString("base64")));
      cache.set(ref, value);
    },
    async delete(ref) {
      cache.delete(ref);
      await file.delete(ref);
    },
  };
}

/**
 * Linux: the Secret Service (GNOME Keyring, KWallet) through `secret-tool`, when the
 * desktop has one. Headless machines and systems without it fall back to a 0600 file.
 */
export function linuxSecrets(path: string, run = runWith): SecretStore {
  const file = fileSecrets(path);
  const attrs = (ref: string) => ["service", SERVICE, "account", ref];
  let available: Promise<boolean> | undefined;
  const keyring = () => {
    // Probe once by writing and reading back a throwaway value.
    available ??= (async () => {
      const probe = "__mingle_probe__";
      const stored = await run("secret-tool", ["store", "--label=Mingle", ...attrs(probe)], "ok", 5000);
      if (stored.code !== 0) return false;
      const read = await run("secret-tool", ["lookup", ...attrs(probe)], "", 5000);
      await run("secret-tool", ["clear", ...attrs(probe)], "", 5000);
      return read.code === 0 && read.stdout === "ok";
    })();
    return available;
  };
  return {
    async get(ref) {
      if (await keyring()) {
        const { code, stdout } = await run("secret-tool", ["lookup", ...attrs(ref)], "");
        if (code === 0) return stdout;
      }
      // Values saved before a keyring was available stay readable.
      return file.get(ref);
    },
    async set(ref, value) {
      if (await keyring()) {
        const { code } = await run("secret-tool", ["store", `--label=Mingle ${ref}`, ...attrs(ref)], value);
        if (code === 0) return file.delete(ref);
      }
      await file.set(ref, value);
    },
    async delete(ref) {
      if (await keyring()) await run("secret-tool", ["clear", ...attrs(ref)], "");
      await file.delete(ref);
    },
  };
}

/** A 0600 JSON file: the fallback where the system offers no credential store. */
export function fileSecrets(path: string): SecretStore {
  const read = (): Record<string, string> => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});
  const write = (data: Record<string, string>) => {
    writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
    chmodSync(path, 0o600);
  };
  return {
    async get(ref) {
      return read()[ref];
    },
    async set(ref, value) {
      write({ ...read(), [ref]: value });
    },
    async delete(ref) {
      const data = read();
      delete data[ref];
      write(data);
    },
  };
}

export function memorySecrets(): SecretStore {
  const data = new Map<string, string>();
  return {
    async get(ref) {
      return data.get(ref);
    },
    async set(ref, value) {
      data.set(ref, value);
    },
    async delete(ref) {
      data.delete(ref);
    },
  };
}

export function defaultSecrets(fallbackPath: string): SecretStore {
  if (process.platform === "darwin") return keychainSecrets();
  if (process.platform === "win32") return windowsSecrets(fallbackPath);
  return linuxSecrets(fallbackPath);
}
