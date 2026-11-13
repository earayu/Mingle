import { delimiter, dirname } from "node:path";

/** Variables that describe the capturing shell itself, not the user's configuration. */
const SHELL_LOCAL = new Set(["_", "PWD", "OLDPWD", "SHLVL"]);

/**
 * Takes the user's login-shell environment into `target` (normally `process.env`).
 * Apps opened from Finder or a Linux desktop start with a minimal environment, so
 * whatever people set up for their harness in ~/.zshrc (ANTHROPIC_API_KEY,
 * ANTHROPIC_BASE_URL, OPENAI_API_KEY, proxies, PATH) would otherwise be missing.
 *
 * The shell's values win, except `MINGLE_*`, which the app that started us chose.
 * Variables the shell removed stay: nothing here is worth losing a working setup over.
 * `fallbackDir` (the bundled Node.js) goes last on PATH, for harnesses that need `node`.
 * Returns the names it changed, never values: the environment contains secrets.
 */
export function applyShellEnvironment(
  target: Record<string, string | undefined>,
  shell: Readonly<Record<string, string | null>>,
  fallbackDir: string,
): string[] {
  const changed: string[] = [];
  for (const [name, value] of Object.entries(shell)) {
    if (value === null || SHELL_LOCAL.has(name) || name.startsWith("MINGLE_")) continue;
    if (target[name] === value) continue;
    target[name] = value;
    changed.push(name);
  }
  const path = target.PATH ?? "";
  const dirs = path.split(delimiter).filter(Boolean);
  if (!dirs.includes(fallbackDir)) target.PATH = [...dirs, fallbackDir].join(delimiter);
  return changed;
}

/** The directory of the Node.js running Mingle. */
export function nodeDir(): string {
  return dirname(process.execPath);
}
