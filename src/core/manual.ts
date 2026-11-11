import { readFileSync } from "node:fs";

const TEMPLATE = new URL("../cli/manual.md", import.meta.url);

/** The operating guide appended to the harness's system prompt; `mingle manual` prints the same text. */
export function renderManual(name: string, role: string): string {
  return readFileSync(TEMPLATE, "utf8")
    .replaceAll("{{name}}", name)
    .replace("{{role}}", role.trim() || "(Your owner has not written a role yet.)");
}
