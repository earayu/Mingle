import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelEvents, ConnectionState, InboundMessage, OnboardingEvent } from "../src/channels/channel.ts";
import { type FeishuApi, feishuChannel, type LarkChannelLike, toInbound } from "../src/channels/feishu/feishu.ts";
import { eventually, type Rig, rig, until } from "./helpers.ts";

const bot = { id: "ou_bot", name: "Alex" };

function message(partial: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    messageId: "om_1",
    chatId: "oc_1",
    chatType: "group",
    senderId: "ou_user",
    senderName: "张三",
    content: "周六天气怎么样？",
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: 1_700_000_000_000,
    ...partial,
  };
}

/** A stand-in for LarkChannel: records what was sent and lets tests emit events. */
function fakeLark() {
  const handlers = new Map<string, (arg: unknown) => unknown>();
  const sent: { to: string; input: unknown; opts: unknown }[] = [];
  let connected = false;
  let failNext: string | undefined;
  const channel = {
    async connect() {
      connected = true;
    },
    async disconnect() {
      connected = false;
    },
    on(name: string, handler: (arg: unknown) => unknown) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    async send(to: string, input: unknown, opts: unknown) {
      if (failNext) {
        const code = failNext;
        failNext = undefined;
        throw Object.assign(new Error(code), { code });
      }
      sent.push({ to, input, opts });
      return { messageId: `om_out_${sent.length}` };
    },
    async addReaction() {
      return "r1";
    },
    async getChatInfo(chatId: string) {
      return { chatId, name: "周末徒步", chatType: "group" };
    },
    rawClient: {},
    botIdentity: undefined,
  } as unknown as LarkChannelLike;
  return {
    channel,
    sent,
    isConnected: () => connected,
    emit: (name: string, arg: unknown) => handlers.get(name)?.(arg),
    failNextSend: (code: string) => {
      failNext = code;
    },
  };
}

function fakeApi(options: { activated: () => boolean; deny?: boolean }): FeishuApi {
  return {
    async register({ onQRCodeReady }) {
      onQRCodeReady({ url: "https://open.feishu.cn/page/launcher?user_code=ABCD", expireIn: 600 });
      await new Promise((r) => setTimeout(r, 20));
      if (options.deny) throw Object.assign(new Error("denied"), { code: "access_denied" });
      return { appId: "cli_1", appSecret: "secret", ownerId: "ou_owner", domain: "feishu" };
    },
    async botInfo() {
      return { name: "Alex", openId: "ou_bot", activated: options.activated() };
    },
  };
}

async function collect(iterable: AsyncIterable<OnboardingEvent>): Promise<OnboardingEvent[]> {
  const out: OnboardingEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

describe("feishu toInbound", () => {
  it("maps a group @-mention", () => {
    expect(toInbound(message({}), bot, "周末徒步")).toMatchObject({
      platformId: "om_1",
      chat: { platformId: "oc_1", kind: "group", name: "周末徒步" },
      sender: { id: "ou_user", name: "张三", isBot: false },
      text: "周六天气怎么样？",
      addressedToBot: true,
      sentAt: 1_700_000_000_000,
    });
  });

  it("treats direct messages as addressed and ignores the bot's own messages", () => {
    expect(toInbound(message({ chatType: "p2p", mentionedBot: false }), bot, undefined)?.addressedToBot).toBe(true);
    expect(toInbound(message({ mentionedBot: false }), bot, undefined)?.addressedToBot).toBe(false);
    expect(toInbound(message({ senderId: "ou_bot" }), bot, undefined)).toBeUndefined();
  });

  it("keeps the message and key for each attachment, and strips a typed @Name", () => {
    const inbound = toInbound(
      message({
        content: "@Alex 看看这个路线",
        replyToMessageId: "om_0",
        resources: [
          { type: "file", fileKey: "file_k", fileName: "route.gpx" },
          { type: "image", fileKey: "img_k" },
        ],
      }),
      bot,
      undefined,
    ) as InboundMessage;
    expect(inbound.text).toBe("看看这个路线");
    expect(inbound.replyTo).toBe("om_0");
    expect(inbound.attachments).toEqual([
      { id: "om_1|file|file_k", name: "route.gpx" },
      { id: "om_1|image|img_k", name: "image-2.png", mime: "image/png" },
    ]);
  });
});

describe("feishu onboarding", () => {
  it("yields the QR, then credentials with the scanner as owner", async () => {
    const channel = feishuChannel({ api: fakeApi({ activated: () => true }) });
    const events = await collect(channel.onboard(undefined, new AbortController().signal, { agentName: "Alex" }));
    expect(events.map((e) => e.kind)).toEqual(["qr_ready", "succeeded"]);
    expect(events[0]).toMatchObject({ qrContent: expect.stringContaining("user_code=ABCD") });
    expect(events[1]).toMatchObject({
      credentials: { appId: "cli_1", appSecret: "secret", domain: "feishu" },
      bot: { id: "ou_bot", name: "Alex" },
      ownerId: "ou_owner",
      pendingApproval: false,
    });
  });

  it("reports a declined authorization", async () => {
    const channel = feishuChannel({ api: fakeApi({ activated: () => true, deny: true }) });
    const events = await collect(channel.onboard(undefined, new AbortController().signal));
    expect(events.at(-1)).toEqual({ kind: "failed", code: "denied" });
  });

  it("binds an existing app by App ID and Secret", async () => {
    const channel = feishuChannel({ api: fakeApi({ activated: () => false }) });
    const events = await collect(channel.onboard({ appId: "cli_9", appSecret: "s" }, new AbortController().signal));
    expect(events).toEqual([
      {
        kind: "succeeded",
        credentials: { appId: "cli_9", appSecret: "s", domain: "feishu" },
        bot: { id: "ou_bot", name: "Alex" },
        pendingApproval: true,
      },
    ]);
  });
});

describe("feishu connection", () => {
  it("waits for admin approval, then connects and relays messages", async () => {
    let active = false;
    const lark = fakeLark();
    const channel = feishuChannel({
      api: fakeApi({ activated: () => active }),
      approvalPollMs: 20,
      createChannel: () => lark.channel,
    });
    const states: ConnectionState[] = [];
    const received: InboundMessage[] = [];
    const events: ChannelEvents = {
      onMessage: (m) => received.push(m),
      onState: (s) => states.push(s),
      onMembership: () => {},
    };
    const connection = await channel.connect({ appId: "cli_1", appSecret: "s" }, events);
    expect(states).toEqual([{ kind: "awaiting_approval" }]);
    expect(lark.isConnected()).toBe(false);
    expect(await connection.send({ chat: { platformId: "oc_1", kind: "group" }, text: "hi" })).toMatchObject({
      kind: "failed",
    });

    active = true;
    await until(() => lark.isConnected(), 2000);
    expect(states.at(-1)).toEqual({ kind: "connected" });

    await lark.emit("message", message({}));
    await until(() => received.length === 1, 2000);
    expect(received[0]?.chat.name).toBe("周末徒步");
    await connection.close();
  });

  it("sends Markdown replies and files, and maps failures", async () => {
    const lark = fakeLark();
    const channel = feishuChannel({ api: fakeApi({ activated: () => true }), createChannel: () => lark.channel });
    const connection = await channel.connect(
      { appId: "cli_1", appSecret: "s" },
      {
        onMessage: () => {},
        onState: () => {},
        onMembership: () => {},
      },
    );
    const dir = mkdtempSync(join(tmpdir(), "mingle-feishu-"));
    writeFileSync(join(dir, "plan.pdf"), "pdf");
    writeFileSync(join(dir, "map.png"), "png");
    const result = await connection.send({
      chat: { platformId: "oc_1", kind: "group" },
      text: "**周六**晴",
      replyTo: "om_1",
      files: [{ path: join(dir, "plan.pdf") }, { path: join(dir, "map.png") }],
    });
    expect(result).toEqual({ kind: "sent", platformId: "om_out_3" });
    expect(lark.sent.map((s) => Object.keys(s.input as object)[0])).toEqual(["markdown", "file", "image"]);
    expect(lark.sent[0]?.opts).toEqual({ replyTo: "om_1" });

    lark.failNextSend("rate_limited");
    expect(await connection.send({ chat: { platformId: "oc_1", kind: "group" }, text: "x" })).toEqual({
      kind: "failed",
      code: "rate_limited",
      retryable: true,
    });
    lark.failNextSend("send_timeout");
    expect(await connection.send({ chat: { platformId: "oc_1", kind: "group" }, text: "x" })).toEqual({
      kind: "uncertain",
    });
    rmSync(dir, { recursive: true, force: true });
    await connection.close();
  });
});

describe("QR onboarding through the console API", () => {
  let current: Rig | undefined;
  afterEach(async () => {
    await current?.close();
    current = undefined;
  });

  it("shows the QR, then lands on a connection owned by the scanner and waiting for approval", async () => {
    let active = false;
    const lark = fakeLark();
    current = await rig(async () => {}, {
      channels: {
        feishu: feishuChannel({
          api: fakeApi({ activated: () => active }),
          approvalPollMs: 20,
          createChannel: () => lark.channel,
        }),
      },
    });
    const { admin, agentId, mingle } = current;
    const platforms = (await admin("GET", "/v1/admin/platforms")).json as {
      platform: string;
      onboarding: unknown;
      manualFields: unknown[];
    }[];
    expect(platforms.find((p) => p.platform === "feishu")).toMatchObject({
      onboarding: { kind: "qr" },
      manualFields: [{}, {}],
    });

    const { id } = (await admin("POST", `/v1/admin/agents/${agentId}/onboarding`, { platform: "feishu" })).json as {
      id: string;
    };
    const qr = await eventually(async () => {
      const state = (await admin("GET", `/v1/admin/onboarding/${id}`)).json as {
        state: string;
        qrSvg?: string;
        url?: string;
      };
      return state.state === "qr" || state.state === "done" ? state : undefined;
    });
    expect(qr.state).toBe("qr");
    expect(qr.qrSvg).toMatch(/^<svg/);

    const result = await eventually(async () => {
      const state = (await admin("GET", `/v1/admin/onboarding/${id}`)).json as {
        state: string;
        connectionId?: string;
        pendingApproval?: boolean;
      };
      return state.state === "done" ? state : undefined;
    });
    expect(result.pendingApproval).toBe(true);
    const connection = mingle.store.connection(result.connectionId as string);
    expect(connection).toMatchObject({
      platform: "feishu",
      ownerId: "ou_owner",
      state: "awaiting_approval",
      botName: "Alex",
    });

    active = true;
    await until(() => mingle.store.connection(result.connectionId as string)?.state === "connected", 3000);
  });
});
