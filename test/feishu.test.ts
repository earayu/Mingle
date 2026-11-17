import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LarkChannelOptions, NormalizedMessage } from "@larksuiteoapi/node-sdk";
import * as sdk from "@larksuiteoapi/node-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelEvents, ConnectionState, InboundMessage, OnboardingEvent } from "../src/channels/channel.ts";
import {
  BOT_MESSAGES_SCOPES,
  FEISHU_SCOPES,
  type FeishuApi,
  feishuChannel,
  GROUP_MESSAGES_SCOPE,
  type LarkChannelLike,
  toInbound,
} from "../src/channels/feishu/feishu.ts";
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
  const reactions: string[] = [];
  const streams: { to: string; opts: unknown; contents: string[] }[] = [];
  const memberCalls: { chatId: string; pageToken: string | undefined }[] = [];
  const contactGets: string[] = [];
  let connected = false;
  let failNext: string | undefined;
  let history: unknown[] | undefined;
  const listed: unknown[] = [];
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
    async addReaction(_id: string, emoji: string) {
      reactions.push(`+${emoji}`);
      return `r-${emoji}`;
    },
    async removeReaction(_id: string, reactionId: string) {
      reactions.push(`-${reactionId}`);
    },
    async stream(to: string, input: { markdown: (c: unknown) => Promise<void> }, opts: unknown) {
      const record = { to, opts, contents: [] as string[] };
      streams.push(record);
      await input.markdown({
        messageId: "om_card",
        append: async () => {},
        setContent: async (full: string) => {
          record.contents.push(full);
        },
      });
      return { messageId: "om_card" };
    },
    async getChatInfo(chatId: string) {
      return { chatId, name: "周末徒步", chatType: "group" };
    },
    rawClient: {
      im: {
        v1: {
          message: {
            async list(request: unknown) {
              listed.push(request);
              if (!history) throw Object.assign(new Error("no permission"), { code: 230027 });
              return { code: 0, data: { items: history } };
            },
            // A message sent to someone by open_id lives in the direct chat Feishu made for it.
            async get({ path }: { path: { message_id: string } }) {
              const to = sent.find((_, i) => `om_out_${i + 1}` === path.message_id)?.to ?? "";
              return { code: 0, data: { items: [{ message_id: path.message_id, chat_id: `oc_dm_${to}` }] } };
            },
          },
          chatMembers: {
            async get({ path, params }: { path: { chat_id: string }; params?: { page_token?: string } }) {
              memberCalls.push({ chatId: path.chat_id, pageToken: params?.page_token });
              return {
                data: {
                  items: params?.page_token
                    ? [{ member_id: "ou_2", name: "李四" }]
                    : [{ member_id: "ou_1", name: "张三" }],
                  has_more: !params?.page_token,
                  page_token: params?.page_token ? undefined : "next",
                },
              };
            },
          },
        },
      },
      contact: {
        v3: {
          user: {
            get: async ({ path }: { path: { user_id: string } }) => {
              contactGets.push(path.user_id);
              return { data: { user: { name: "李四" } } };
            },
          },
        },
      },
    },
    botIdentity: { openId: "ou_bot", name: "Alex" },
  } as unknown as LarkChannelLike;
  return {
    channel,
    sent,
    memberCalls,
    contactGets,
    isConnected: () => connected,
    reactions,
    streams,
    emit: (name: string, arg: unknown) => handlers.get(name)?.(arg),
    failNextSend: (code: string) => {
      failNext = code;
    },
    setHistory: (items: unknown[] | undefined) => {
      history = items;
    },
    listed,
  };
}

function fakeApi(options: {
  activated: () => boolean;
  deny?: boolean;
  hold?: Promise<void>;
  scopes?: () => ReadonlyMap<string, boolean>;
  onRegister?: (options: { appId: string | undefined }) => void;
}): FeishuApi {
  return {
    async register({ appId, onQRCodeReady }) {
      options.onRegister?.({ appId });
      onQRCodeReady({ url: "https://open.feishu.cn/page/launcher?user_code=ABCD", expireIn: 600 });
      await (options.hold ?? new Promise((r) => setTimeout(r, 20)));
      if (options.deny) throw Object.assign(new Error("denied"), { code: "access_denied" });
      return { appId: "cli_1", appSecret: "secret", ownerId: "ou_owner", domain: "feishu" };
    },
    async botInfo() {
      return { name: "Alex", openId: "ou_bot", activated: options.activated() };
    },
    async scopes() {
      if (!options.scopes) throw new Error("offline");
      return options.scopes();
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

  it("asks to update the same app when re-authorizing a connected bot", async () => {
    const updated: (string | undefined)[] = [];
    const channel = feishuChannel({
      api: fakeApi({ activated: () => true, onRegister: ({ appId }) => updated.push(appId) }),
    });
    const events = await collect(
      channel.onboard(undefined, new AbortController().signal, { reauthorize: { appId: "cli_1" } }),
    );
    expect(updated).toEqual(["cli_1"]);
    expect(events.at(-1)).toMatchObject({ kind: "succeeded", credentials: { appId: "cli_1" } });
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

  it("relays group messages that do not @ the bot, and lists chat members", async () => {
    const lark = fakeLark();
    const channel = feishuChannel({ api: fakeApi({ activated: () => true }), createChannel: () => lark.channel });
    const received: InboundMessage[] = [];
    const connection = await channel.connect(
      { appId: "cli_1", appSecret: "s" },
      { onMessage: (m) => received.push(m), onState: () => {}, onMembership: () => {} },
    );
    // requireMention is off, so background talk reaches the core as a non-triggering message.
    await lark.emit("message", message({ mentionedBot: false }));
    await until(() => received.length === 1, 2000);
    expect(received[0]?.addressedToBot).toBe(false);

    expect(connection.capabilities().listMembers).toBe(true);
    expect(await connection.listMembers({ platformId: "oc_1", kind: "group" })).toEqual([
      { id: "ou_1", name: "张三", isBot: false },
      { id: "ou_2", name: "李四", isBot: false },
    ]);
    expect(lark.memberCalls).toEqual([
      { chatId: "oc_1", pageToken: undefined },
      { chatId: "oc_1", pageToken: "next" },
    ]);
    await connection.close();
  });
});

describe("feishu group messages permission", () => {
  const events = { onMessage: () => {}, onState: () => {}, onMembership: () => {} };

  it("asks for every group message when the app is created, and lets them through the SDK", async () => {
    expect(FEISHU_SCOPES).toContain(GROUP_MESSAGES_SCOPE);
    // A member also sees what other bots say: Feishu pushes those only with the include_bot variants.
    expect(FEISHU_SCOPES).toEqual(expect.arrayContaining([...BOT_MESSAGES_SCOPES]));
    const lark = fakeLark();
    let options: LarkChannelOptions | undefined;
    const channel = feishuChannel({
      api: fakeApi({ activated: () => true }),
      createChannel: (o) => {
        options = o;
        return lark.channel;
      },
    });
    const connection = await channel.connect({ appId: "cli_1", appSecret: "s" }, events);
    expect(options?.policy).toMatchObject({ requireMention: false });
    // sender_type lives on the raw event, which the SDK drops unless asked to keep it.
    expect(options?.includeRawEvent).toBe(true);
    await connection.close();
  });

  it("marks other bots' live messages, without looking them up in contacts", async () => {
    const lark = fakeLark();
    const channel = feishuChannel({ api: fakeApi({ activated: () => true }), createChannel: () => lark.channel });
    const received: InboundMessage[] = [];
    const connection = await channel.connect(
      { appId: "cli_1", appSecret: "s" },
      { onMessage: (m) => received.push(m), onState: () => {}, onMembership: () => {} },
    );
    const raw = (senderType: string) => ({
      sender: { sender_id: { open_id: "ou_x" }, sender_type: senderType },
      message: {},
    });
    const unnamed = (partial: Partial<NormalizedMessage>) => {
      const m = message(partial);
      delete m.senderName;
      return m;
    };
    await lark.emit("message", unnamed({ senderId: "ou_ci", raw: raw("app") }));
    await lark.emit("message", unnamed({ senderId: "ou_li", raw: raw("user") }));
    await until(() => received.length === 2, 2000);
    expect(received[0]?.sender).toEqual({ id: "ou_ci", name: "", isBot: true });
    expect(received[1]?.sender).toMatchObject({ id: "ou_li", name: "李四", isBot: false });
    // The contact lookup cannot resolve a bot, so only the person was looked up.
    expect(lark.contactGets).toEqual(["ou_li"]);
    await connection.close();
  });

  it("writes first to someone by open_id and reports the direct chat Feishu made", async () => {
    const lark = fakeLark();
    const channel = feishuChannel({ api: fakeApi({ activated: () => true }), createChannel: () => lark.channel });
    const connection = await channel.connect({ appId: "cli_1", appSecret: "s" }, events);
    const to = await connection.openDirect?.("ou_9");
    expect(to).toBe("ou_9");
    const result = await connection.send({ chat: { platformId: to as string, kind: "dm" }, text: "hi" });
    expect(lark.sent[0]?.to).toBe("ou_9");
    expect(result).toEqual({ kind: "sent", platformId: "om_out_1", chat: "oc_dm_ou_9" });
    // A chat Feishu already named needs no lookup.
    expect(await connection.send({ chat: { platformId: "oc_dm_ou_9", kind: "dm" }, text: "again" })).toEqual({
      kind: "sent",
      platformId: "om_out_2",
    });
    await connection.close();
  });

  it("gives each bot its own duplicate check, so two bots in one group both get a message", async () => {
    const options: LarkChannelOptions[] = [];
    const channel = feishuChannel({
      api: fakeApi({ activated: () => true }),
      createChannel: (o) => {
        options.push(o);
        return fakeLark().channel;
      },
    });
    const a = await channel.connect({ appId: "cli_a", appSecret: "s" }, events);
    const b = await channel.connect({ appId: "cli_b", appSecret: "s" }, events);
    const [first, second] = options.map((o) => o.cache);
    expect(first).toBeDefined();
    expect(first).not.toBe(second);
    expect(first).not.toBe(sdk.internalCache);
    // What the SDK writes once bot A has handled a message must not mark it seen for bot B.
    await first?.set("om_same", "1", Date.now() + 60_000, { namespace: "channel:seen" });
    expect(await second?.get("om_same", { namespace: "channel:seen" })).toBeUndefined();
    await a.close();
    await b.close();
  });

  it("reports whether the scope is granted, and reads it again once it is", async () => {
    let granted = new Map<string, boolean>();
    const now = Date.now();
    const clock = { at: now };
    const realNow = Date.now;
    Date.now = () => clock.at;
    try {
      const channel = feishuChannel({
        api: fakeApi({ activated: () => true, scopes: () => granted }),
        createChannel: () => fakeLark().channel,
      });
      const connection = await channel.connect({ appId: "cli_1", appSecret: "s", domain: "lark" }, events);
      // No link: Feishu adds it to the same app by scanning again from the bot's settings.
      expect(await connection.permissions?.()).toEqual([
        { id: "group_messages", granted: false },
        { id: "bot_messages", granted: false },
      ]);
      granted = new Map([[GROUP_MESSAGES_SCOPE, true]]);
      expect((await connection.permissions?.())?.[0]?.granted).toBe(false);
      clock.at += 20_000;
      // group_msg alone is not enough to hear other bots; both include_bot scopes count as one.
      expect(await connection.permissions?.()).toEqual([
        { id: "group_messages", granted: true },
        { id: "bot_messages", granted: false },
      ]);
      clock.at += 20_000;
      granted = new Map([
        [GROUP_MESSAGES_SCOPE, true],
        [BOT_MESSAGES_SCOPES[0], true],
        [BOT_MESSAGES_SCOPES[1], true],
      ]);
      expect(await connection.permissions?.()).toEqual([
        { id: "group_messages", granted: true },
        { id: "bot_messages", granted: true },
      ]);
      await connection.close();
    } finally {
      Date.now = realNow;
    }
  });

  it("reads a group's latest messages when it joins, as the group's past", async () => {
    const lark = fakeLark();
    // Newest first, as Feishu lists them with ByCreateTimeDesc.
    lark.setHistory([
      // The bot's own words from an earlier stay in the group: the list names it by its app ID.
      {
        message_id: "om_4",
        msg_type: "text",
        create_time: "1700000004000",
        chat_id: "oc_9",
        sender: { id: "cli_1", id_type: "app_id", sender_type: "app" },
        body: { content: JSON.stringify({ text: "I was here before" }) },
      },
      {
        message_id: "om_3",
        msg_type: "text",
        create_time: "1700000003000",
        chat_id: "oc_9",
        sender: { id: "cli_ci", id_type: "app_id", sender_type: "app" },
        body: { content: JSON.stringify({ text: "deploy failed" }) },
      },
      {
        message_id: "om_2",
        msg_type: "text",
        create_time: "1700000002000",
        chat_id: "oc_9",
        sender: { id: "ou_li", id_type: "open_id", sender_type: "user" },
        body: { content: JSON.stringify({ text: "@_user_1 周六去哪？" }) },
        mentions: [{ key: "@_user_1", id: "ou_bot", id_type: "open_id", name: "Alex" }],
      },
      { message_id: "om_1", msg_type: "system", chat_id: "oc_9", sender: { id: "x", id_type: "", sender_type: "" } },
      {
        message_id: "om_0",
        msg_type: "text",
        deleted: true,
        sender: { id: "ou_li", id_type: "open_id", sender_type: "user" },
      },
    ]);
    const received: InboundMessage[] = [];
    const joined: string[] = [];
    const channel = feishuChannel({ api: fakeApi({ activated: () => true }), createChannel: () => lark.channel });
    const connection = await channel.connect(
      { appId: "cli_1", appSecret: "s" },
      { onMessage: (m) => received.push(m), onState: () => {}, onMembership: (m) => joined.push(m.chat.platformId) },
    );
    await lark.emit("botAdded", { chatId: "oc_9" });
    await until(() => received.length === 2, 2000);
    expect(joined).toEqual(["oc_9"]);
    expect(lark.listed[0]).toMatchObject({
      params: { container_id_type: "chat", container_id: "oc_9", sort_type: "ByCreateTimeDesc", page_size: 50 },
    });
    expect(received.map((m) => [m.platformId, m.text, m.sender.name, m.sender.isBot, m.earlier])).toEqual([
      ["om_2", "周六去哪？", "李四", false, true],
      ["om_3", "deploy failed", "", true, true],
    ]);
    expect(received[0]?.chat).toEqual({ platformId: "oc_9", kind: "group", name: "周末徒步" });
    expect(received[0]?.sentAt).toBe(1_700_000_002_000);
    await connection.close();
  });

  it("starts from now when it may not read the group's messages", async () => {
    const lark = fakeLark();
    const received: InboundMessage[] = [];
    const joined: string[] = [];
    const channel = feishuChannel({ api: fakeApi({ activated: () => true }), createChannel: () => lark.channel });
    const connection = await channel.connect(
      { appId: "cli_1", appSecret: "s" },
      { onMessage: (m) => received.push(m), onState: () => {}, onMembership: (m) => joined.push(m.chat.platformId) },
    );
    await lark.emit("botAdded", { chatId: "oc_9" });
    expect(joined).toEqual(["oc_9"]);
    expect(lark.listed).toHaveLength(1);
    expect(received).toEqual([]);
    await connection.close();
  });

  it("reports nothing when it cannot tell", async () => {
    const channel = feishuChannel({ api: fakeApi({ activated: () => true }), createChannel: () => fakeLark().channel });
    const connection = await channel.connect({ appId: "cli_1", appSecret: "s" }, events);
    expect(await connection.permissions?.()).toEqual([]);
    await connection.close();
  });
});

describe("feishu reactions and live cards", () => {
  it("swaps OnIt for DONE, and streams one card that ends with the answer and an @-mention", async () => {
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
    const chat = { platformId: "oc_1", kind: "group" as const };
    await connection.react(chat, "om_1", "processing");
    await connection.react(chat, "om_1", "done");
    expect(lark.reactions).toEqual(["+OnIt", "-r-OnIt", "+DONE"]);

    const live = await connection.startLive?.(chat, {
      replyTo: "om_1",
      mention: "ou_asker",
      initial: "**正在思考** · 0 秒",
    });
    await live?.update("**正在处理** · 3 秒\n\n· 运行命令");
    const result = await live?.finish("**周六**晴");
    expect(result).toEqual({ kind: "sent", platformId: "om_card" });
    expect(lark.streams).toHaveLength(1);
    expect(lark.streams[0]?.opts).toEqual({ replyTo: "om_1" });
    expect(lark.streams[0]?.contents).toEqual([
      "**正在思考** · 0 秒",
      "**正在处理** · 3 秒\n\n· 运行命令",
      "<at id=ou_asker></at> **周六**晴",
    ]);
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
    let releaseScan = () => {};
    const scanHold = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    current = await rig(async () => {}, {
      channels: {
        feishu: feishuChannel({
          api: fakeApi({ activated: () => active, hold: scanHold }),
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
    releaseScan();

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

  it("re-authorizes a connected bot: the scan updates the same app and reuses the connection", async () => {
    const lark = fakeLark();
    const holds: { release: () => void }[] = [];
    const updated: (string | undefined)[] = [];
    current = await rig(async () => {}, {
      channels: {
        feishu: feishuChannel({
          api: fakeApi({
            activated: () => true,
            hold: new Promise<void>((resolve) => holds.push({ release: resolve })),
            onRegister: ({ appId }) => updated.push(appId),
          }),
          createChannel: () => lark.channel,
        }),
      },
    });
    const { admin, agentId, mingle } = current;
    const platforms = (await admin("GET", "/v1/admin/platforms")).json as {
      platform: string;
      reauthorize: boolean;
    }[];
    expect(platforms.find((p) => p.platform === "feishu")?.reauthorize).toBe(true);

    // First scan creates the app and its connection.
    const first = (await admin("POST", `/v1/admin/agents/${agentId}/onboarding`, { platform: "feishu" })).json as {
      id: string;
    };
    holds.shift()?.release();
    const created = await eventually(async () => {
      const state = (await admin("GET", `/v1/admin/onboarding/${first.id}`)).json as {
        state: string;
        connectionId?: string;
      };
      return state.state === "done" ? state : undefined;
    });
    const connectionId = created.connectionId as string;
    expect(updated).toEqual([undefined]);

    // Scanning again for that connection updates the same app instead of creating a bot.
    const second = (await admin("POST", `/v1/admin/agents/${agentId}/onboarding`, { platform: "feishu", connectionId }))
      .json as { id: string };
    holds.shift()?.release();
    const redone = await eventually(async () => {
      const state = (await admin("GET", `/v1/admin/onboarding/${second.id}`)).json as {
        state: string;
        connectionId?: string;
      };
      return state.state === "done" ? state : undefined;
    });
    expect(updated).toEqual([undefined, "cli_1"]);
    expect(redone.connectionId).toBe(connectionId);
    expect(mingle.store.connections(agentId).filter((n) => n.platform === "feishu")).toHaveLength(1);
  });
});
