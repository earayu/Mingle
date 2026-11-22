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

interface RoleCacheEntry {
  mtimeNs: bigint;
  ctimeNs: bigint;
  size: bigint;
  ino: bigint;
  content: string;
}

/** Stat-validated cache for ROLE.md so frequent console status polls avoid re-reading unchanged files. */
const roleCache = new Map<string, RoleCacheEntry>();

export function readRole(dir: string): string {
  const path = join(dir, "ROLE.md");
  try {
    const stat = statSync(path, { bigint: true });
    const cached = roleCache.get(path);
    if (
      cached &&
      cached.mtimeNs === stat.mtimeNs &&
      cached.ctimeNs === stat.ctimeNs &&
      cached.size === stat.size &&
      cached.ino === stat.ino
    ) {
      return cached.content;
    }
    const content = readFileSync(path, "utf8");
    if (roleCache.size >= 128) roleCache.clear();
    roleCache.set(path, {
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
      size: stat.size,
      ino: stat.ino,
      content,
    });
    return content;
  } catch {
    roleCache.delete(path);
    return "";
  }
}

export function writeRole(dir: string, role: string): void {
  const path = join(dir, "ROLE.md");
  const content = role.trim() ? `${role.trim()}\n` : "";
  writeFileSync(path, content);
  try {
    const stat = statSync(path, { bigint: true });
    roleCache.set(path, {
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
      size: stat.size,
      ino: stat.ino,
      content,
    });
  } catch {
    roleCache.delete(path);
  }
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

/** How long the agent must have been idle before its tidy-up, so it never competes with a conversation. */
export const TIDY_IDLE_MS = 2 * 3_600_000;
/** At most one tidy-up in this long: roughly once a day, drifting with when the agent is idle. */
export const TIDY_EVERY_MS = 20 * 3_600_000;

/**
 * Whether the agent is due its memory tidy-up (docs/spec.md 4.5): it is switched on, the agent
 * has been idle long enough, the last one was most of a day ago, and somebody has talked to it
 * since. An agent nobody spoke to has nothing new to tidy and is never woken for it.
 */
export function tidyDue(input: {
  on: boolean;
  now: number;
  idleSince: number;
  tidyAt: number | null;
  lastInAt: number | null;
}): boolean {
  if (!input.on || input.lastInAt == null) return false;
  if (input.now - input.idleSince < TIDY_IDLE_MS) return false;
  if (input.tidyAt == null) return true;
  return input.now - input.tidyAt >= TIDY_EVERY_MS && input.lastInAt > input.tidyAt;
}

/** The note that starts the tidy-up: what to look at, what to change, and to stay out of the chats. */
export function tidyText(since: number | null): string {
  const window = since == null ? "your recent work" : `what happened since ${new Date(since).toISOString()}`;
  return `[mingle] Daily memory tidy-up. Nobody is waiting on you. Look back over ${window}: your own session, "$MINGLE_CLI" message read and search, task list and reminder list. Then update MEMORY.md and notes/: record what you will need later and could not look up again (decisions, preferences, who owns what, where work stands and what comes next), mark finished work finished, delete what is superseded or no longer true, and note patterns you only see across several conversations. Keep MEMORY.md a short index and put details in notes/. Check against current sources before deleting. Do not send any message; this turn is for your memory only.`;
}
