import { MingleError } from "./errors.ts";

/**
 * An agent's own environment variables (docs/spec.md 3, 4.4). Names are in SQLite, values only
 * in the secret store. Nothing here logs or returns a value.
 */

const NAME = /^[A-Z_][A-Z0-9_]*$/;
const MAX_NAME = 128;
/** Enough for a PEM key or a long token; environments have limits of their own. */
export const MAX_ENV_VALUE = 32 * 1024;

/**
 * Variables a harness or its shell depends on. Setting them would break the brain or change how
 * every command runs, so they are refused. `MINGLE_*` is Mingle's own.
 */
const SYSTEM = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "OLDPWD",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TERM",
  "TZ",
  "IFS",
  "BASH_ENV",
  "ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
  // Windows names are case-insensitive, so the uppercase spelling is the same variable.
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
]);
const SYSTEM_PREFIXES = ["LC_", "DYLD_", "LD_"];

/** Throws a stable code when `name` cannot be an agent's variable. */
export function checkEnvName(name: string): void {
  if (!NAME.test(name) || name.length > MAX_NAME) {
    throw new MingleError("env_name_invalid", "use capital letters, digits and underscores, not starting with a digit");
  }
  if (name.startsWith("MINGLE_")) throw new MingleError("env_name_reserved", "MINGLE_ names are Mingle's own");
  if (SYSTEM.has(name) || SYSTEM_PREFIXES.some((p) => name.startsWith(p))) {
    throw new MingleError("env_name_system", "this is a system variable the harness depends on; choose another name");
  }
}

export function checkEnvValue(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MingleError("env_value_required", "give the variable a value");
  }
  if (value.length > MAX_ENV_VALUE) throw new MingleError("env_value_too_large", "values are limited to 32 KB");
  if (value.includes("\0")) throw new MingleError("env_value_invalid", "values cannot contain a NUL character");
}

/** The secret store key for one variable. */
export const envRef = (agentId: string, name: string) => `env:${agentId}:${name}`;

/**
 * Values are stored JSON-encoded: the macOS Keychain takes them on stdin line by line, so a
 * multi-line value (a PEM key) would otherwise be cut at its first newline.
 */
export const encodeEnvValue = (value: string) => JSON.stringify(value);

export function decodeEnvValue(stored: string): string {
  try {
    const value = JSON.parse(stored);
    if (typeof value === "string") return value;
  } catch {}
  return stored;
}
