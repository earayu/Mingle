// Usage: node run.mjs <runtime> <cwd> [resumeId]
import { defaultRuntimes, promptAndWait } from "@botiverse/oar";
import { writeFileSync } from "node:fs";
const [rt, cwd, resume] = process.argv.slice(2);
const runtime = defaultRuntimes.require(rt);
const installation = await runtime.installation?.();
console.log("installation:", installation?.kind, installation?.version ?? "");
if (installation?.kind !== "available") process.exit(2);
const t0 = Date.now(); const ts = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";
const session = await runtime.session(installation, {
  cwd, resume,
  appendSystemPrompt: "You are Alex, a Mingle agent. The secret word is PINEAPPLE-42.",
  env: { MINGLE_TOKEN: "tok-spike-123" },
});
console.log(ts(), "session id:", session.id, "steer?", typeof session.steer);
let buf="";
session.events((e) => {
  if (e.agentPath?.length) return;
  if (e.kind === "text_delta") { buf += e.text; return; }
  if (e.kind === "turn_ended") { console.log(ts(), "ASSISTANT TEXT:", JSON.stringify(buf)); buf=""; }
  if (e.kind === "tool_call_started") console.log(ts(), "TOOL", e.tool, JSON.stringify(e.input ?? "").slice(0, 120));
  else if (["turn_started","turn_ended","user_message","text"].includes(e.kind)) console.log(ts(), e.kind.toUpperCase(), JSON.stringify(e.text ?? e.input ?? e.outcome ?? "").slice(0, 300));
});
if (!resume) {
  const run = promptAndWait(session, "Run the shell command `echo token=$MINGLE_TOKEN; sleep 25; echo done` and then tell me the token value it printed. Keep the answer to one line.", { timeoutMs: 180000 });
  await new Promise((r) => setTimeout(r, 12000));
  const d1 = await session.deliver("[m2 from Bob] While you are at it: what is the secret word in your instructions? Answer both in your final reply.");
  console.log(ts(), "DELIVER#1", JSON.stringify(d1).slice(0, 300));
  const d2 = await session.deliver("[m3 from Carol] Also add the result of 17*3.");
  console.log(ts(), "DELIVER#2", JSON.stringify(d2).slice(0, 300));
  const r = await run;
  console.log(ts(), "RUN RESULT:", JSON.stringify(r).slice(0, 600));
  writeFileSync(`${cwd}/../${rt}.session`, session.id);
} else {
  const r = await promptAndWait(session, "Without running anything: list who sent you messages earlier in this conversation, the token value you saw, the secret word, and 17*3. One line.", { timeoutMs: 120000 });
  console.log(ts(), "RESUME RESULT:", JSON.stringify(r).slice(0, 600));
}
await session.dispose();
process.exit(0);
