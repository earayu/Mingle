import { describe, expect, it } from "vitest";
import type { InboundMessage, OnboardingEvent } from "../src/channels/channel.ts";
import { type Frame, toInbound, type WecomClientLike, wecomChannel } from "../src/channels/wecom/wecom.ts";
import { until } from "./helpers.ts";

/** A stand-in for the SDK's WSClient. */
function fakeClient(options: { authFails?: boolean } = {}) {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const calls: { method: string; args: unknown[] }[] = [];
  const emit = (event: string, ...args: unknown[]) => {
    for (const h of handlers.get(event) ?? []) h(...args);
  };
  const client: WecomClientLike = {
    connect() {
      setTimeout(
        () =>
          options.authFails ? emit("error", new Error("Authentication failed: invalid secret")) : emit("authenticated"),
        5,
      );
    },
    disconnect() {
      calls.push({ method: "disconnect", args: [] });
    },
    on(event, listener) {
      handlers.set(event, [...(handlers.get(event) ?? []), listener as (...args: unknown[]) => void]);
    },
    async replyStream(...args) {
      calls.push({ method: "replyStream", args });
    },
    async sendMessage(...args) {
      calls.push({ method: "sendMessage", args });
    },
    async uploadMedia() {
      return { media_id: "m1" };
    },
    async sendMediaMessage(...args) {
      calls.push({ method: "sendMediaMessage", args });
    },
    async downloadFile() {
      return { buffer: Buffer.from("x") };
    },
  };
  return { client, calls, emit };
}

const frame = (body: Partial<NonNullable<Frame["body"]>>): Frame => ({
  headers: { req_id: "req-1" },
  body: { msgid: "msg1", from: { userid: "zhangsan" }, chattype: "single", msgtype: "text", ...body },
});

describe("wecom messages", () => {
  it("maps direct and group messages, dropping the leading @mention", () => {
    expect(toInbound(frame({ text: { content: "周六天气？" } }))).toMatchObject({
      platformId: "msg1",
      chat: { platformId: "zhangsan", kind: "dm" },
      sender: { id: "zhangsan" },
      text: "周六天气？",
      addressedToBot: true,
    });
    expect(
      toInbound(frame({ chattype: "group", chatid: "wr123", text: { content: "@Alex 周六天气？" } })),
    ).toMatchObject({ chat: { platformId: "wr123", kind: "group" }, text: "周六天气？" });
  });

  it("lists images and files, including those inside mixed messages", () => {
    const inbound = toInbound(
      frame({
        msgtype: "mixed",
        mixed: {
          msg_item: [
            { msgtype: "text", text: { content: "看图" } },
            { msgtype: "image", image: { url: "https://x/i" } },
          ],
        },
      }),
    ) as InboundMessage;
    expect(inbound.text).toBe("看图");
    expect(inbound.attachments).toEqual([{ id: "msg1:0", name: "image-msg1-0.jpg", mime: "image/jpeg" }]);
  });
});

describe("wecom onboarding", () => {
  it("shows the QR from WeCom, then returns the bot's credentials", async () => {
    let polls = 0;
    const fetchImpl = (async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/generate")) {
        expect(url.searchParams.get("source")).toBe("mingle");
        return Response.json({ data: { scode: "S1", auth_url: "https://work.weixin.qq.com/ai/qc/auth?scode=S1" } });
      }
      polls++;
      return Response.json({
        data: polls < 2 ? { status: "waiting" } : { status: "success", bot_info: { botid: "aib1", secret: "sec" } },
      });
    }) as typeof fetch;
    const channel = wecomChannel({ fetch: fetchImpl, pollEveryMs: 5 });
    const events: OnboardingEvent[] = [];
    for await (const e of channel.onboard(undefined, new AbortController().signal, { agentName: "Alex" }))
      events.push(e);
    expect(events.map((e) => e.kind)).toEqual(["qr_ready", "succeeded"]);
    expect(events[0]).toMatchObject({ qrContent: "https://work.weixin.qq.com/ai/qc/auth?scode=S1" });
    expect(events[1]).toMatchObject({
      credentials: { botId: "aib1", secret: "sec", name: "Alex" },
      bot: { id: "aib1" },
    });
  });

  it("refuses an authorization page outside WeCom", async () => {
    const fetchImpl = (async () =>
      Response.json({ data: { scode: "S1", auth_url: "https://evil.example/qc" } })) as typeof fetch;
    const events: OnboardingEvent[] = [];
    for await (const e of wecomChannel({ fetch: fetchImpl }).onboard(undefined, new AbortController().signal))
      events.push(e);
    expect(events).toEqual([{ kind: "failed", code: "network" }]);
  });

  it("checks manual credentials by connecting once", async () => {
    const bad = fakeClient({ authFails: true });
    const events: OnboardingEvent[] = [];
    for await (const e of wecomChannel({ createClient: () => bad.client, connectTimeoutMs: 500 }).onboard(
      { botId: "b", secret: "wrong" },
      new AbortController().signal,
    ))
      events.push(e);
    expect(events).toEqual([{ kind: "failed", code: "invalid_credentials" }]);
  });
});

describe("wecom connection", () => {
  it("streams the live reply onto the inbound message and falls back to sendMessage without one", async () => {
    const fake = fakeClient();
    const received: InboundMessage[] = [];
    const connection = await wecomChannel({ createClient: () => fake.client }).connect(
      { botId: "aib1", secret: "s", name: "Alex" },
      { onMessage: (m) => received.push(m), onState: () => {}, onMembership: () => {} },
    );
    expect(connection.bot).toEqual({ id: "aib1", name: "Alex" });
    const inbound = frame({ text: { content: "hi" } });
    fake.emit("message", inbound);
    await until(() => received.length === 1, 1000);

    const live = await connection.startLive?.(
      { platformId: "zhangsan", kind: "dm" },
      { replyTo: "msg1", initial: "正在思考" },
    );
    await live?.update("正在处理");
    expect(await live?.finish("答案")).toMatchObject({ kind: "sent" });
    const streams = fake.calls.filter((c) => c.method === "replyStream");
    expect(streams.map((c) => [c.args[2], c.args[3]])).toEqual([
      ["正在思考", false],
      ["正在处理", false],
      ["答案", true],
    ]);
    expect(streams.every((c) => c.args[0] === inbound && c.args[1] === streams[0]?.args[1])).toBe(true);

    await connection.send({ chat: { platformId: "wr123", kind: "group" }, text: "主动消息" });
    expect(fake.calls.find((c) => c.method === "sendMessage")?.args).toEqual([
      "wr123",
      { msgtype: "markdown", markdown: { content: "主动消息" } },
    ]);
    await connection.close();
  });
});
