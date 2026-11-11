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

/** A 0600 JSON file. For Linux, where there is no Keychain. */
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
  return process.platform === "darwin" ? keychainSecrets() : fileSecrets(fallbackPath);
}
