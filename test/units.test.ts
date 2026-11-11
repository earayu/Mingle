import { describe, expect, it } from "vitest";
import { toInbound } from "../src/channels/telegram/telegram.ts";
import { formatMessage } from "../src/core/format.ts";
import { split } from "../src/core/outbox.ts";
import { nextFire, parseDuration } from "../src/core/schedule.ts";

describe("formatMessage", () => {
  it("puts everything an agent needs on one header line", () => {
    const text = formatMessage(
      {
        id: "m8f2a",
        chatId: "c12",
        direction: "in",
        platformId: "1",
        senderId: "u1",
        senderName: 'Zhang "San"',
        body: "hello",
        attachments: [{ id: "f3a1", ref: "x", name: "route.gpx" }],
        replyTo: null,
        triggers: true,
        state: "received",
        createdAt: Date.UTC(2026, 10, 11, 6, 2),
      },
      { id: "c12", connectionId: "n1", platformId: "-100", kind: "group", name: "Weekend hikes" },
      "feishu",
      { ownerId: "u1" },
    );
    const [header, body] = text.split("\n");
    expect(header).toMatch(
      /^\[msg=m8f2a chat=c12 im=feishu group="Weekend hikes" from="Zhang 'San'" owner file=f3a1:"route\.gpx" time=2026-11-11T\d\d:\d\d[+-]\d\d:\d\d\]$/,
    );
    expect(body).toBe("hello");
  });
});

describe("schedule", () => {
  it("parses durations", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("2d")).toBe(172_800_000);
    expect(() => parseDuration("soon")).toThrow(/invalid_duration/);
  });

  it("finds the next daily and weekly time", () => {
    const base = new Date(2026, 10, 11, 10, 0).getTime(); // Wednesday 10:00 local
    expect(new Date(nextFire("daily@09:00", base))).toEqual(new Date(2026, 10, 12, 9, 0));
    expect(new Date(nextFire("daily@11:30", base))).toEqual(new Date(2026, 10, 11, 11, 30));
    expect(new Date(nextFire("weekly:mon,fri@09:00", base))).toEqual(new Date(2026, 10, 13, 9, 0));
    expect(nextFire("every:15m", base)).toBe(base + 900_000);
    expect(() => nextFire("weekly:funday@09:00", base)).toThrow(/invalid_rule/);
  });
});

describe("split", () => {
  it("keeps short text whole and cuts long text at line breaks", () => {
    expect(split("short", 10)).toEqual(["short"]);
    const parts = split(`${"a".repeat(8)}\n${"b".repeat(8)}`, 12);
    expect(parts).toEqual(["a".repeat(8), "b".repeat(8)]);
    expect(split("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });
});

describe("telegram toInbound", () => {
  const me = { id: 42, is_bot: true, first_name: "Alex", username: "alex_bot" };
  const group = { id: -100, type: "supergroup" as const, title: "Weekend hikes" };
  const from = { id: 7, is_bot: false, first_name: "Zhang", last_name: "San" };

  it("strips the bot mention and marks the message as addressed", () => {
    const text = "@alex_bot what is the weather?";
    const inbound = toInbound(
      { message_id: 5, from, chat: group, date: 1, text, entities: [{ type: "mention", offset: 0, length: 9 }] },
      me,
    );
    expect(inbound).toMatchObject({
      platformId: "5",
      text: "what is the weather?",
      addressedToBot: true,
      chat: { platformId: "-100", kind: "group", name: "Weekend hikes" },
      sender: { id: "7", name: "Zhang San", isBot: false },
      sentAt: 1000,
    });
  });

  it("ignores group chatter that does not address the bot", () => {
    const inbound = toInbound({ message_id: 6, from, chat: group, date: 1, text: "anyone up for Saturday?" }, me);
    expect(inbound?.addressedToBot).toBe(false);
  });

  it("treats replies to the bot and /command@bot as addressed", () => {
    const reply = toInbound(
      {
        message_id: 7,
        from,
        chat: group,
        date: 1,
        text: "thanks",
        reply_to_message: { message_id: 3, from: me, chat: group, date: 1 },
      },
      me,
    );
    expect(reply).toMatchObject({ addressedToBot: true, replyTo: "3" });
    const stop = toInbound({ message_id: 8, from, chat: group, date: 1, text: "/stop@alex_bot" }, me);
    expect(stop).toMatchObject({ addressedToBot: true, text: "/stop" });
  });

  it("maps direct messages, topics and attachments", () => {
    const dm = toInbound(
      {
        message_id: 9,
        from,
        chat: { id: 7, type: "private", first_name: "Zhang" },
        date: 1,
        caption: "route",
        document: { file_id: "F1", file_name: "route.gpx", file_size: 10 },
      },
      me,
    );
    expect(dm).toMatchObject({ chat: { kind: "dm", platformId: "7" }, addressedToBot: true, text: "route" });
    expect(dm?.attachments).toEqual([{ id: "F1", name: "route.gpx", size: 10 }]);
    const topic = toInbound(
      {
        message_id: 10,
        message_thread_id: 4,
        is_topic_message: true,
        from,
        chat: { ...group, is_forum: true },
        date: 1,
        text: "@alex_bot hi",
        entities: [{ type: "mention", offset: 0, length: 9 }],
        reply_to_message: { message_id: 4, chat: group, date: 1 },
      },
      me,
    );
    expect(topic).toMatchObject({ chat: { kind: "thread", platformId: "-100:4" } });
    expect(topic?.replyTo).toBeUndefined();
  });
});
