// Checks a running Mingle for inbound IM messages that never got an answer.
// Used during the manual IM smoke (docs/im-smoke.md): send the checklist
// messages on each platform, then run this and expect "all answered".
//
//   node scripts/im-smoke-check.mjs [--home ~/.mingle] [--minutes 30]
//
// Reads <home>/runtime.json for the URL and admin token, asks every agent's
// activity feed, and exits 1 while any inbound message from the last
// --minutes window is still received/delivered/unanswered.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    home: { type: "string", default: join(homedir(), ".mingle") },
    minutes: { type: "string", default: "30" },
  },
});

const runtime = JSON.parse(readFileSync(join(values.home, "runtime.json"), "utf8"));
const base = runtime.url.replace(/\/$/, "");
const auth = { authorization: `Bearer ${runtime.adminToken}` };

const pending = new Set(["received", "delivered", "unanswered"]);
const since = Date.now() - Number(values.minutes) * 60_000;
let bad = 0;

const status = await fetch(`${base}/v1/admin/status`, { headers: auth }).then((r) => r.json());
for (const agent of status.agents) {
  const activity = await fetch(`${base}/v1/admin/agents/${agent.id}/activity?limit=200`, {
    headers: auth,
  }).then((r) => r.json());
  const open = activity.filter(
    (m) => m.direction === "in" && pending.has(m.state) && new Date(m.createdAt).getTime() > since,
  );
  if (!open.length) {
    console.log(`${agent.name}: all inbound messages answered`);
    continue;
  }
  bad += open.length;
  console.log(`${agent.name}: ${open.length} unanswered`);
  for (const m of open) {
    const age = Math.round((Date.now() - new Date(m.createdAt).getTime()) / 1000);
    console.log(
      `  [${m.state}] ${m.platform} ${m.chat?.name ?? m.chat?.id} ${m.sender ?? "?"} (${age}s ago): ${m.body}`,
    );
  }
}

if (bad) {
  console.log(`\n${bad} message(s) still unanswered — the agent may be stuck or a platform is down`);
  process.exit(1);
}
