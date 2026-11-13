import { afterEach, describe, expect, it } from "vitest";
import { Mingle } from "../src/core/mingle.ts";
import { messageIds, type Rig, rig, runCli, until } from "./helpers.ts";

/** Pausing and resuming an agent (docs/spec.md 4.11). */

let current: Rig | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

const dm = { platformId: "7", kind: "dm" as const, name: "Zhang San" };

describe("pausing an agent", () => {
  it("ends the work in hand, takes no messages, tells each chat once, and resumes", async () => {
    let env: Record<string, string> = {};
    current = await rig(
      async (t) => {
        env = t.options.env as Record<string, string>;
        if (t.input.includes("long job")) {
          await t.tool("Bash", "long job", () => sleep(10_000, t.signal));
          return;
        }
        for (const id of messageIds(t.input)) await runCli(env, ["message", "reply", id], `on it ${id}`);
      },
      { live: true },
    );
    const { channel, mingle, agentId, admin } = current;

    channel.receive({ text: "start the long job", chat: dm });
    await until(() => current?.turns.length === 1);
    await until(() => mingle.store.agent(agentId)?.status === "working");
    const chat = mingle.store.agentChats(agentId)[0]?.id as string;
    const first = mingle.store.chatMessages(chat, 10).find((m) => m.direction === "in");

    expect(await admin("POST", `/v1/admin/agents/${agentId}/pause`)).toEqual({ status: 200, json: { changed: true } });
    expect(mingle.store.agent(agentId)?.status).toBe("paused");
    expect(mingle.runtime(agentId)).toBeUndefined();
    // The message it was working on is settled, and its live reply says why.
    expect(mingle.store.message(first?.id as string)?.state).toBe("ignored");
    await until(() => channel.lives[0]?.final);
    expect(channel.lives[0]?.final).toBe("*Paused. This message won't get a reply.*");
    // Pausing again changes nothing.
    expect((await admin("POST", `/v1/admin/agents/${agentId}/pause`)).json).toEqual({ changed: false });

    // The old session can no longer speak for it.
    const late = await runCli(env, ["message", "send", "--to", chat], "late result");
    expect(late.code).not.toBe(0);
    expect(late.stderr).toContain("unauthorized");

    // New messages: not handed over, and the chat hears once that it is paused.
    channel.receive({ text: "are you there?", chat: dm });
    channel.receive({ text: "hello?", chat: dm });
    channel.receive({ text: "/stop", chat: dm });
    await until(() => channel.sent.some((m) => m.text === "Alex is paused and not replying for now."));
    await sleep(300);
    expect(channel.sent.filter((m) => m.text.includes("paused"))).toHaveLength(1);
    expect(channel.sent.some((m) => m.text === "late result")).toBe(false);
    expect(current.turns).toHaveLength(1);
    const inbound = mingle.store.chatMessages(chat, 20).filter((m) => m.direction === "in");
    expect(inbound.every((m) => m.state === "ignored")).toBe(true);
    // Live replies are not opened for a paused agent.
    expect(channel.lives).toHaveLength(1);

    // Retrying needs the agent back first.
    const retry = await admin("POST", `/v1/admin/agents/${agentId}/messages/retry`, {});
    expect(retry).toMatchObject({ status: 409, json: { error: "agent_paused" } });

    // A reminder that comes due while paused waits.
    mingle.store.createReminder({
      agentId,
      body: "Check the forecast",
      rule: "once",
      timezone: "UTC",
      chatId: null,
      nextFireAt: Date.now() - 1000,
    });
    mingle.fireReminders();
    await sleep(300);
    expect(current.turns).toHaveLength(1);

    // Resume: the reminder fires, and messages are answered again.
    expect((await admin("POST", `/v1/admin/agents/${agentId}/resume`)).json).toEqual({ changed: true });
    expect((await admin("POST", `/v1/admin/agents/${agentId}/resume`)).json).toEqual({ changed: false });
    await until(() => current?.turns.some((t) => t.input.includes("Check the forecast")));
    await until(() => mingle.store.agent(agentId)?.status === "idle");
    const back = channel.receive({ text: "welcome back", chat: dm });
    await until(() => mingle.store.messageByPlatformId(chat, back.platformId)?.state === "replied");
    // After a resume, a new pause tells the chat again.
    await admin("POST", `/v1/admin/agents/${agentId}/pause`);
    channel.receive({ text: "and now?", chat: dm });
    await until(() => channel.sent.filter((m) => m.text.includes("paused")).length === 2);
  });

  it("survives quick toggling and keeps a single session", async () => {
    current = await rig(async (t) => {
      for (const id of messageIds(t.input))
        await runCli(t.options.env as Record<string, string>, ["message", "reply", id], "ok");
    });
    const { channel, mingle, agentId, admin } = current;
    for (let i = 0; i < 3; i++) {
      await admin("POST", `/v1/admin/agents/${agentId}/pause`);
      await admin("POST", `/v1/admin/agents/${agentId}/resume`);
    }
    expect(mingle.isPaused(agentId)).toBe(false);
    channel.receive({ text: "still there?", chat: dm });
    await until(() => channel.sent.some((m) => m.text === "ok"));
    expect(current.turns).toHaveLength(1);
  });

  it("stays paused across a restart", async () => {
    current = await rig(async () => {});
    const { mingle, agentId, admin } = current;
    await admin("POST", `/v1/admin/agents/${agentId}/pause`);

    const again = new Mingle(mingle.options);
    await again.start("http://127.0.0.1:1");
    try {
      expect(again.isPaused(agentId)).toBe(true);
      expect(again.runtime(agentId)).toBeUndefined();
      expect(again.store.agent(agentId)?.status).toBe("paused");
    } finally {
      await again.stop();
    }
  });

  it("can delete a paused agent", async () => {
    current = await rig(async () => {});
    const { mingle, agentId, admin } = current;
    await admin("POST", `/v1/admin/agents/${agentId}/pause`);
    expect((await admin("DELETE", `/v1/admin/agents/${agentId}`)).status).toBe(200);
    expect(mingle.store.agent(agentId)).toBeUndefined();
    expect(mingle.isPaused(agentId)).toBe(false);
  });
});
