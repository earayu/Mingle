import { afterEach, describe, expect, it } from "vitest";
import { type Rig, rig, until } from "./helpers.ts";

/**
 * Against real harnesses on this machine. Opt-in: it spends the harness's quota.
 *
 *   MINGLE_E2E=claude,codex pnpm vitest run test/e2e.test.ts
 *
 * Entries are harness ids, optionally `id:model` to pick a model explicitly
 * (otherwise the harness's own configured default is used). Every listed
 * harness gets the short "reply PONG" smoke; the longer multi-sender turn
 * runs only for the deep subset, `MINGLE_E2E_DEEP` (default claude,codex),
 * intersected with MINGLE_E2E. About a minute per harness, a few minutes
 * per deep one.
 */
interface Target {
  readonly id: string;
  readonly model?: string | undefined;
}

function parseTargets(value: string | undefined): Target[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf(":");
      return at === -1 ? { id: entry } : { id: entry.slice(0, at), model: entry.slice(at + 1) || undefined };
    });
}

const targets = parseTargets(process.env.MINGLE_E2E);
const deepIds = new Set(parseTargets(process.env.MINGLE_E2E_DEEP ?? "claude,codex").map((t) => t.id));
const deep = targets.filter((t) => deepIds.has(t.id));

let current: Rig | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function pongSmoke(target: Target): Promise<void> {
  current = await rig(async () => {}, {
    harness: target.id,
    model: target.model ?? null,
    real: true,
    coalesceMs: 300,
  });
  const { channel } = current;

  channel.receive({ text: "Hi Alex! Reply with exactly: PONG" });
  const first = await until(() => channel.sent[0], 180_000);
  expect(first.text).toMatch(/PONG/);
  expect(first.replyTo).toBeDefined();
}

describe.skipIf(targets.length === 0)("real harnesses", () => {
  for (const target of targets) {
    it(`${target.id}: answers through the CLI`, async () => {
      await pongSmoke(target);
    }, 240_000);
  }
});

describe.skipIf(deep.length === 0)("real harnesses, deep turn", () => {
  for (const target of deep) {
    it(`${target.id}: reads the guide and handles a second person mid-turn`, async () => {
      current = await rig(async () => {}, {
        harness: target.id,
        model: target.model ?? null,
        real: true,
        coalesceMs: 300,
      });
      const { channel, mingle } = current;

      channel.receive({ text: "Hi Alex! Reply with exactly: PONG" });
      const first = await until(() => channel.sent[0], 180_000);
      expect(first.text).toMatch(/PONG/);
      expect(first.replyTo).toBeDefined();

      // Two people at once, the second while the agent is working.
      channel.receive({ text: "Please run `sleep 15` in the shell, then tell me the word BANANA." });
      await until(() => mingle.runtime(current?.agentId as string)?.busy, 60_000);
      channel.receive({
        text: "Also, what is 17 times 3? Reply to me separately.",
        sender: { id: "u2", name: "Li Si", isBot: false },
      });
      // Done when every message has been answered (an "on it" first is fine) and the agent is idle again.
      const chat = mingle.store.agentChats(current.agentId)[0]?.id as string;
      const inboundOf = () => mingle.store.chatMessages(chat, 20).filter((m) => m.direction === "in");
      await until(
        () => inboundOf().length === 3 && inboundOf().every((m) => m.state !== "delivered" && m.state !== "received"),
        300_000,
      );
      await until(() => !mingle.runtime(current?.agentId as string)?.busy, 120_000);
      // Messages sent after "done" (a final answer after an acknowledgement) still count.
      await new Promise((r) => setTimeout(r, 2000));
      const inbound = inboundOf();
      console.log(
        mingle.store
          .chatMessages(chat, 20)
          .map(
            (m) =>
              `${m.direction === "in" ? "<-" : "->"} ${m.id} ${m.state}${m.replyTo ? ` (re ${m.replyTo})` : ""}: ${m.body}`,
          )
          .join("\n"),
      );
      expect(inbound.every((m) => m.state === "replied")).toBe(true);
      const texts = channel.sent
        .slice(1)
        .map((m) => m.text)
        .join("\n");
      expect(texts).toMatch(/BANANA/i);
      expect(texts).toMatch(/51/);
    }, 420_000);
  }
});
