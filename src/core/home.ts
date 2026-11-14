import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Create an agent's home directory. Mingle only ever writes ROLE.md (from the console), MEMORY.md and notes/ here. */
export function createHome(dir: string, name: string, role: string): void {
  mkdirSync(join(dir, "notes"), { recursive: true });
  const rolePath = join(dir, "ROLE.md");
  if (!existsSync(rolePath)) writeFileSync(rolePath, role.trim() ? `${role.trim()}\n` : "");
  const memoryPath = join(dir, "MEMORY.md");
  if (!existsSync(memoryPath)) {
    writeFileSync(
      memoryPath,
      `# ${name}'s memory\n\nA short recovery index: who you work with, what is in progress, links into notes/.\n`,
    );
  }
}

export function readRole(dir: string): string {
  try {
    return readFileSync(join(dir, "ROLE.md"), "utf8");
  } catch {
    return "";
  }
}

export function writeRole(dir: string, role: string): void {
  writeFileSync(join(dir, "ROLE.md"), role.trim() ? `${role.trim()}\n` : "");
}

/** Size of MEMORY.md in bytes, or 0 when there is none. */
export function memorySize(dir: string): number {
  try {
    return statSync(join(dir, "MEMORY.md")).size;
  } catch {
    return 0;
  }
}

/** MEMORY.md is read at the start of every session; past this size Mingle asks the agent to trim it. */
export const MEMORY_LIMIT = 64 * 1024;

/**
 * Whether to tell the agent now that MEMORY.md is too large (docs/spec.md 4.5): it is over the
 * limit, and either it was never said, a day has passed, or the file grew by a quarter since.
 */
export function memoryHintDue(size: number, last: { at: number; size: number } | undefined, now: number): boolean {
  if (size <= MEMORY_LIMIT) return false;
  if (!last) return true;
  return now - last.at >= 24 * 3_600_000 || size >= last.size * 1.25;
}

/** The note Mingle sends: what is wrong, why it matters, and what to do. */
export function memoryHint(size: number): string {
  const kb = (n: number) => `${Math.round(n / 1024)} KB`;
  return `[mingle] Your MEMORY.md is ${kb(size)}, over the ${kb(MEMORY_LIMIT)} it should stay under. It is read at the start of every session, so its size slows down and costs every one. Trim it now: drop finished work and superseded decisions, keep it an index, and move details into notes/. Check against current sources before deleting; old notes may still hold. No chat reply is needed.`;
}
