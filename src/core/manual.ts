import { readFileSync } from "node:fs";

const TEMPLATE = new URL("../cli/manual.md", import.meta.url);

/**
 * On Windows a harness may run commands in PowerShell, where `"$MINGLE_CLI"` and heredocs
 * mean nothing. Only Windows agents read this.
 */
const POWERSHELL = `
## If your shell is PowerShell

The examples are bash. In PowerShell, run the CLI with \`& $env:MINGLE_CLI\` and pipe the body in as a here-string, after setting UTF-8 so non-English text survives:

\`\`\`powershell
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
@'
Saturday looks clear.
'@ | & $env:MINGLE_CLI message reply m8f2a
\`\`\`
`;

/** The operating guide appended to the harness's system prompt; `mingle manual` prints the same text. */
export function renderManual(name: string, role: string, platform: NodeJS.Platform = process.platform): string {
  const manual = readFileSync(TEMPLATE, "utf8")
    .replaceAll("{{name}}", name)
    .replace("{{role}}", role.trim() || "(Your owner has not written a role yet.)");
  return platform === "win32" ? `${manual.trimEnd()}\n${POWERSHELL}` : manual;
}
