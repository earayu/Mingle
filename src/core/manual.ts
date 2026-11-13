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

/**
 * The names of the variables the owner set for this agent. Never their values: the guide goes into
 * the transcript and to the model's provider.
 */
function envSection(names: readonly string[], platform: NodeJS.Platform): string {
  const read = platform === "win32" ? "`$env:NAME` in PowerShell, `$NAME` in bash" : "`$NAME`";
  return `
## Environment variables set for you

Your owner set these for you: ${names.map((n) => `\`${n}\``).join(", ")}. Read them in your shell as ${read}. They hold secrets such as webhook addresses and API keys: use them in commands, and do not write their values into messages, files or notes.
`;
}

/** The operating guide appended to the harness's system prompt; `mingle manual` prints the same text. */
export function renderManual(
  name: string,
  role: string,
  platform: NodeJS.Platform = process.platform,
  envNames: readonly string[] = [],
): string {
  let manual = readFileSync(TEMPLATE, "utf8")
    .replaceAll("{{name}}", name)
    .replace("{{role}}", role.trim() || "(Your owner has not written a role yet.)");
  if (envNames.length) manual = `${manual.trimEnd()}\n${envSection(envNames, platform)}`;
  return platform === "win32" ? `${manual.trimEnd()}\n${POWERSHELL}` : manual;
}
