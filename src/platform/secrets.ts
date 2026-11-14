import { execFile } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/** Where IM credentials live. Never SQLite, never logs. */
export interface SecretStore {
  get(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

const SERVICE = "app.mingle";
const SECURITY = "/usr/bin/security";

/** Base64 characters per Keychain item: `security -i` reads at most 4095 characters per command line. */
const CHUNK = 3000;

/**
 * macOS Keychain through /usr/bin/security.
 *
 * Writes go through `security -i`, which reads its commands from stdin, so a secret never
 * appears in argv. The plain `add-generic-password -w` prompt is not usable: it keeps only the
 * first 128 characters, which silently cut every bot's credentials until Mingle restarted and
 * read them back. `find-generic-password -w` prints anything that is not printable ASCII as
 * hex, so values are stored base64-encoded (`b64:`), and values longer than one command line
 * are split over `<ref>#1..n` with `parts:<n>` under `<ref>`. Every write is read back and
 * compared, so a value that would not survive a restart fails now instead.
 */
export function keychainSecrets(run = runWith, service = SERVICE): SecretStore {
  const quote = (ref: string) => {
    if (/["\\\n\r]/.test(ref)) throw new Error("invalid secret reference");
    return `"${ref}"`;
  };
  const read = async (ref: string) => {
    const { code, stdout } = await run(SECURITY, ["find-generic-password", "-s", service, "-a", ref, "-w"], "");
    return code === 0 ? stdout.replace(/\n$/, "") : undefined;
  };
  const parts = (stored: string | undefined) => {
    const match = stored?.match(/^parts:(\d+)$/);
    return match ? Number(match[1]) : 0;
  };
  const deleteCommands = (ref: string, count: number) =>
    [...Array.from({ length: count }, (_, i) => `${ref}#${i + 1}`), ref].map(
      (account) => `delete-generic-password -s ${quote(service)} -a ${quote(account)}`,
    );
  const store: SecretStore = {
    async get(ref) {
      const stored = await read(ref);
      if (stored === undefined) return undefined;
      const count = parts(stored);
      if (count > 0) {
        let joined = "";
        for (let i = 1; i <= count; i++) {
          const part = await read(`${ref}#${i}`);
          if (part === undefined) return undefined;
          joined += part;
        }
        return Buffer.from(joined, "base64").toString("utf8");
      }
      if (stored.startsWith("b64:")) return Buffer.from(stored.slice(4), "base64").toString("utf8");
      // Written before b64: values were plain JSON, printed as hex when not plain ASCII.
      if (/^(?:[0-9a-f]{2})+$/i.test(stored)) return Buffer.from(stored, "hex").toString("utf8");
      return stored;
    },
    async set(ref, value) {
      const previous = parts(await read(ref));
      const encoded = Buffer.from(value, "utf8").toString("base64");
      const add = (account: string, data: string) =>
        `add-generic-password -s ${quote(service)} -a ${quote(account)} -U -w "${data}"`;
      const commands: string[] = [];
      let count = 0;
      if (encoded.length <= CHUNK) commands.push(add(ref, `b64:${encoded}`));
      else {
        for (let at = 0; at < encoded.length; at += CHUNK) {
          count++;
          commands.push(add(`${ref}#${count}`, encoded.slice(at, at + CHUNK)));
        }
        commands.push(add(ref, `parts:${count}`));
      }
      // Parts left over from a longer earlier value.
      for (let i = count + 1; i <= previous; i++) {
        commands.push(`delete-generic-password -s ${quote(service)} -a ${quote(`${ref}#${i}`)}`);
      }
      await run(SECURITY, ["-i"], `${commands.join("\n")}\n`);
      // Deleting stale parts that are already gone fails harmlessly, so the read-back is the check.
      if ((await store.get(ref)) !== value) throw new Error("could not save the credentials to the Keychain");
    },
    async delete(ref) {
      const count = parts(await read(ref));
      await run(SECURITY, ["-i"], `${deleteCommands(ref, count).join("\n")}\n`);
    },
  };
  return store;
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
