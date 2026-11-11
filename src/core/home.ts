import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
