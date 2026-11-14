// Cold-start spike against real Claude Code (docs/spec.md 12). Spends real quota (a few dollars).
//
//   node spikes/cold-start-live.ts [idle-minutes=65] > cold-start.log
//
// Two identical agents, same history: a few chat turns with decisions, then a large document that
// takes the context past 128K tokens. After the idle, both get the same two questions. Agent A
// resumes (today's behavior); agent B runs with MINGLE_COLD_START=rebuild. Prints each agent's
// cold-turn measurement and both answers.
import { readFileSync } from "node:fs";
import { type Rig, rig, until } from "../test/helpers.ts";

const idleMinutes = Number(process.argv[2] ?? 65);
const repo = new URL("..", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repo), "utf8");
const handbook = [
  "docs/spec.md",
  "src/core/mingle.ts",
  "src/core/runtime.ts",
  "src/core/live.ts",
  "src/core/outbox.ts",
  "src/core/format.ts",
  "src/core/link.ts",
  "src/core/brains.ts",
  "src/core/inbound.ts",
  "src/harness/harness.ts",
  "src/store/store.ts",
  "src/api/server.ts",
]
  .map((p) => `===== ${p} =====\n${read(p)}`)
  .join("\n\n");

const say = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

async function agent(label: string, coldStart?: string) {
  const logs: string[] = [];
  const r = await rig(async () => {}, {
    harness: "claude",
    real: true,
    coalesceMs: 300,
    ...(coldStart ? { coldStart } : {}),
    log: (line) => {
      logs.push(line);
      if (/cold (turn|start)/.test(line)) say(`[${label}] ${line}`);
    },
  });
  return { label, r, logs };
}

type Agent = Awaited<ReturnType<typeof agent>>;

/** Send to both agents at once and wait until each has answered and gone idle. */
async function both(agents: Agent[], text: string): Promise<string[]> {
  return Promise.all(
    agents.map(async ({ r }) => {
      const before = r.channel.sent.length;
      r.channel.receive({ text });
      await until(() => r.channel.sent.length > before, 15 * 60_000);
      await idle(r);
      return r.channel.sent
        .slice(before)
        .map((m) => m.text)
        .join("\n");
    }),
  );
}

async function idle(r: Rig): Promise<void> {
  await until(() => r.mingle.store.agent(r.agentId)?.status === "idle", 15 * 60_000);
  await new Promise((resolve) => setTimeout(resolve, 5000));
  await until(() => r.mingle.store.agent(r.agentId)?.status === "idle", 15 * 60_000);
}

const agents = [await agent("A resume"), await agent("B rebuild", "rebuild")];
try {
  say("history");
  await both(
    agents,
    "Hi Alex, I'm Zhang San. For Saturday's hike we decided: meet at 7:30 at the north trailhead parking lot; Li Wei can't come; everyone brings 2 liters of water. Just confirm you have it.",
  );
  await both(
    agents,
    `Here is the handbook of a side project I'm reviewing. Skim it and tell me in one sentence what it is.\n\n${handbook}`,
  );
  await both(agents, "Thanks. One more for Saturday: Wang Fang brings the first-aid kit.");
  for (const { label, logs } of agents) say(`[${label}] history done; last log: ${logs.at(-1)}`);

  say(`idle ${idleMinutes} min`);
  await new Promise((resolve) => setTimeout(resolve, idleMinutes * 60_000));

  const probes = [
    "Remind me: when and where do we meet on Saturday, who isn't coming, and who brings the first-aid kit?",
    "In that handbook, how long does Mingle wait between tries when the provider is busy, before the message fails?",
  ];
  for (const probe of probes) {
    say(`probe: ${probe}`);
    const answers = await both(agents, probe);
    answers.forEach((answer, i) => say(`[${agents[i]?.label}] answer: ${answer.replaceAll("\n", " ")}`));
  }
  for (const { label, r } of agents) {
    say(`[${label}] session ${r.mingle.store.agent(r.agentId)?.sessionId} previous ${r.mingle.store.previousSessionId(r.agentId)}`);
  }
} finally {
  for (const { r } of agents) await r.close();
}
