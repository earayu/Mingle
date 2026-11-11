import { afterEach, describe, expect, it } from "vitest";
import { type Rig, rig, until } from "./helpers.ts";

/**
 * Against a real harness on this machine. Opt-in: it spends the harness's quota.
 *   MINGLE_E2E=claude pnpm vitest run test/e2e.test.ts
 */
const harness = process.env.MINGLE_E2E;

let current: Rig | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

describe.skipIf(!harness)(`real harness: ${harness}`, () => {
  it("reads the guide, answers through the CLI, and handles a second person mid-turn", async () => {
    current = await rig(async () => {}, { harness: harness as string, real: true, coalesceMs: 300 });
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
    await until(() => channel.sent.length >= 3, 240_000);
    const texts = channel.sent
      .slice(1)
      .map((m) => m.text)
      .join("\n");
    expect(texts).toMatch(/BANANA/i);
    expect(texts).toMatch(/51/);

    const chat = mingle.store.agentChats(current.agentId)[0]?.id as string;
    const inbound = mingle.store.chatMessages(chat, 20).filter((m) => m.direction === "in");
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
  }, 420_000);
});
