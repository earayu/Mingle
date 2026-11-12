import { afterEach, describe, expect, it } from "vitest";
import { LiveReplies, stepKind } from "../src/core/live.ts";
import { messageIds, type Rig, rig, runCli, until } from "./helpers.ts";

let current: Rig | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("step labels", () => {
  it("names tools from different harnesses in plain words", () => {
    expect(stepKind("Bash")).toBe("command");
    expect(stepKind("exec_command")).toBe("command");
    expect(stepKind("Read")).toBe("read");
    expect(stepKind("apply_patch")).toBe("edit");
    expect(stepKind("Grep")).toBe("search");
    expect(stepKind("WebFetch")).toBe("web");
    expect(stepKind("TodoWrite")).toBe("plan");
    expect(stepKind("mystery")).toBe("other");
  });

  it("renders elapsed time and the latest steps, newest last", () => {
    let now = 0;
    const replies = new LiveReplies(
      () => {},
      () => now,
    );
    now = 75_000;
    const text = replies.render({
      lang: "zh",
      startedAt: 0,
      working: true,
      steps: [
        { kind: "read", count: 1 },
        { kind: "command", count: 3 },
        { kind: "web", count: 1 },
      ],
    });
    expect(text).toBe("**正在处理** · 1 分 15 秒\n\n- 查看文件\n- 运行命令 ×3\n- 查资料…");
  });
});

describe("live replies", () => {
  it("shows progress at once, then turns into the answer", async () => {
    current = await rig(
      async (t) => {
        await t.tool("Bash", "curl forecast", () => sleep(1300));
        const [id] = messageIds(t.input);
        await runCli(t.options.env as Record<string, string>, ["message", "reply", id as string], "Saturday is clear.");
      },
      { live: true },
    );
    const { channel, mingle } = current;
    const inbound = channel.receive({ text: "weather on Saturday?" });

    const live = await until(() => channel.lives[0]);
    expect(live.replyTo).toBe(inbound.platformId);
    expect(live.updates[0]).toMatch(/^\*\*Thinking\*\* · 0s$/);
    await until(() => live.final);
    expect(live.final).toBe("Saturday is clear.");
    expect(live.updates.some((u) => u.includes("**Working**") && u.includes("Running a command"))).toBe(true);
    // The answer went into the live reply: no separate message.
    expect(channel.sent).toHaveLength(0);
    expect(channel.reactions).toEqual([`${inbound.platformId}:processing`, `${inbound.platformId}:done`]);
    const chat = mingle.store.agentChats(current.agentId)[0]?.id as string;
    const out = mingle.store.chatMessages(chat, 10).find((m) => m.direction === "out");
    expect(out).toMatchObject({ body: "Saturday is clear.", platformId: live.platformId, state: "sent" });
  });

  it("closes the live reply with a note when the message goes unanswered", async () => {
    current = await rig(async () => {}, { live: true });
    const { channel } = current;
    const inbound = channel.receive({ text: "hello?" });
    await until(() => channel.lives[0]?.final);
    expect(channel.lives[0]?.final).toBe("*This message did not get a reply.*");
    expect(channel.reactions.at(-1)).toBe(`${inbound.platformId}:none`);
  });

  it("marks the live reply answered when the agent sends to the chat instead of replying", async () => {
    current = await rig(
      async (t) => {
        const chat = /chat=(c\w+)/.exec(t.input)?.[1] as string;
        await runCli(t.options.env as Record<string, string>, ["message", "send", "--to", chat], "Here you go.");
      },
      { live: true },
    );
    const { channel } = current;
    channel.receive({ text: "anything new?" });
    await until(() => channel.lives[0]?.final);
    expect(channel.lives[0]?.final).toBe("*Answered below.*");
    expect(channel.sent.map((m) => m.text)).toEqual(["Here you go."]);
  });
});
