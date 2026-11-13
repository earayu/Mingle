import { describe, expect, it } from "vitest";
import type { InboundMessage, OnboardingEvent } from "../src/channels/channel.ts";
import { type QqBotLike, type QqInbound, qqChannel, toInbound } from "../src/channels/qq/qq.ts";
import { until } from "./helpers.ts";

const dm: QqInbound = {
  kind: "c2c",
  senderId: "u1",
  content: " 你好 ",
  messageId: "m1",
  timestamp: "2026-11-12T10:00:00+08:00",
  replyTarget: { scope: "c2c", targetId: "u1", msgId: "m1" },
};

function fakeBot() {
  const handlers: Record<string, (a: unknown, b?: unknown) => void> = {};
  const calls: { op: string; args: unknown[] }[] = [];
  const bot: QqBotLike = {
    on(event: string, handler: (a: unknown, b?: unknown) => void) {
      handlers[event] = handler;
      return bot;
    },
    async start() {
      handlers.ready?.({});
      await new Promise(() => {});
    },
    stop() {},
    async sendText(...args) {
      calls.push({ op: "text", args });
      return { id: "out1" };
    },
    async sendTyping(...args) {
      calls.push({ op: "typing", args });
    },
    async sendImage(...args) {
      calls.push({ op: "image", args });
      return { message: { id: "img1" } };
    },
    async sendFile(...args) {
      calls.push({ op: "file", args });
      throw new Error("no file permission");
    },
    openStream(opts) {
      calls.push({ op: "stream", args: [opts] });
      return {
        async update(text: string) {
          calls.push({ op: "update", args: [text] });
        },
        async complete() {
          calls.push({ op: "complete", args: [] });
          return { id: "s1" };
        },
        cancel() {},
      };
    },
    api: { getToken: async () => "tok" },
  } as QqBotLike;
  return { bot, calls, push: (msg: QqInbound) => handlers.message?.({}, msg) };
}

describe("qq messages", () => {
  it("maps direct and group messages and skips guilds", () => {
    expect(toInbound(dm)).toMatchObject({ chat: { platformId: "u1", kind: "dm" }, text: "你好", addressedToBot: true });
    expect(
      toInbound({ ...dm, kind: "group", groupOpenid: "g1", replyTarget: { scope: "group", targetId: "g1" } }),
    ).toMatchObject({ chat: { platformId: "g1", kind: "group" } });
    expect(toInbound({ ...dm, kind: "guild" })).toBeUndefined();
    expect(
      toInbound({ ...dm, attachments: [{ content_type: "image/png", url: "https://x/1.png" }] })?.attachments,
    ).toEqual([{ id: "m1:0", name: "image-1", mime: "image/png" }]);
  });
});

describe("qq onboarding", () => {
  it("turns connector callbacks into events and names the owner", async () => {
    const events: OnboardingEvent[] = [];
    const channel = qqChannel({
      startQr: ((callbacks: Parameters<typeof import("@tencent-connect/qqbot-connector").startQrConnect>[0]) => {
        setTimeout(() => callbacks.onQrDisplayed?.("https://q.qq.com/qr/abc"), 1);
        setTimeout(() => callbacks.onSuccess([{ appId: "app1", appSecret: "sec", userOpenid: "owner1" }]), 5);
        return () => {};
      }) as never,
    });
    for await (const e of channel.onboard(undefined, new AbortController().signal, { agentName: "Alex" })) {
      events.push(e);
    }
    expect(events.map((e) => e.kind)).toEqual(["qr_ready", "succeeded"]);
    expect(events[1]).toMatchObject({
      credentials: { appId: "app1", appSecret: "sec", name: "Alex" },
      ownerId: "owner1",
    });
  });
});

describe("qq connection", () => {
  it("replies passively, streams in direct chats, and sends images", async () => {
    const fake = fakeBot();
    const received: InboundMessage[] = [];
    const connection = await qqChannel({ createBot: () => fake.bot }).connect(
      { appId: "app1", appSecret: "sec", name: "Alex" },
      { onMessage: (m) => received.push(m), onState: () => {}, onMembership: () => {} },
    );
    fake.push(dm);
    await until(() => received.length === 1, 1000);

    await connection.react(received[0]?.chat as never, "m1", "processing");
    expect(fake.calls.at(-1)).toMatchObject({ op: "typing", args: [{ msgId: "m1" }, 60] });

    const live = await connection.startLive?.({ platformId: "u1", kind: "dm" }, { replyTo: "m1", initial: "正在思考" });
    await live?.update("**正在处理** · 2 秒");
    expect(await live?.finish("答案")).toMatchObject({ kind: "sent", platformId: "s1" });
    expect(fake.calls.filter((c) => c.op === "update").map((c) => c.args[0])).toEqual([
      "正在思考",
      "正在处理 · 2 秒",
      "答案",
    ]);

    const sent = await connection.send({
      chat: { platformId: "u1", kind: "dm" },
      text: "图在这",
      replyTo: "m1",
      files: [{ path: "/tmp/route.png" }, { path: "/tmp/route.gpx" }],
    });
    expect(sent).toMatchObject({ kind: "sent", platformId: "img1", degraded: ["markdown_flattened", "files_dropped"] });
    expect(fake.calls.find((c) => c.op === "text")?.args).toEqual([
      { scope: "c2c", targetId: "u1", msgId: "m1" },
      "图在这",
    ]);
    await expect(
      connection.startLive?.({ platformId: "g1", kind: "group" }, { replyTo: "m1", initial: "x" }) as Promise<unknown>,
    ).rejects.toThrow();
    await connection.close();
  });
});

describe("qq start failures", () => {
  it("tells refused credentials from an unreachable QQ", async () => {
    const { startFailure } = await import("../src/channels/qq/qq.ts");
    expect(startFailure(new Error("Network error getting access_token: fetch failed"))).toBe("network");
    expect(startFailure(new Error("Token fetch failed: HTTP 502 — bad gateway"))).toBe("network");
    expect(startFailure(new Error("Token fetch failed: HTTP 401 — invalid appsecret"))).toBe("credentials_revoked");
    expect(startFailure(new Error('Failed to get access_token: {"code":100016}'))).toBe("credentials_revoked");
  });

  it("does not call a network failure revoked credentials", async () => {
    const states: unknown[] = [];
    const { bot } = fakeBot();
    bot.start = async () => {
      throw new Error("Network error getting access_token: getaddrinfo ENOTFOUND bots.qq.com");
    };
    const channel = qqChannel({ createBot: () => bot, readyTimeoutMs: 50 });
    await expect(
      channel.connect(
        { appId: "a", appSecret: "s" },
        { onMessage() {}, onState: (s) => states.push(s), onMembership() {} },
      ),
    ).rejects.toThrow(/Network error/);
    expect(states).toEqual([]);
  });
});
