import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LarkChannelOptions, NormalizedMessage } from "@larksuiteoapi/node-sdk";
import * as sdk from "@larksuiteoapi/node-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelEvents, ConnectionState, InboundMessage, OnboardingEvent } from "../src/channels/channel.ts";
import {
  BOT_MESSAGES_SCOPES,
  FEISHU_SCOPES,
  type FeishuApi,
  feishuChannel,
  GROUP_MESSAGES_SCOPE,
  groupThread,
  type LarkChannelLike,
  PROFILE_SCOPES,
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
  /** Streaming cards, as the CardKit calls left them. */
  const cards: {
    replyTo: string;
    replyInThread?: boolean;
    contents: string[];
    streaming: boolean;
    summary?: string;
    sequences: number[];
  }[] = [];
  /** Feishu error codes the next element content updates fail with, one per update. */
  const failUpdates: number[] = [];
  /** Feishu error codes the next full card updates fail with, one per update. */
  const failFinal: number[] = [];
  /** Feishu error codes the next settings calls fail with, one per call. */
  const failSettings: number[] = [];
  /** How many card.settings calls were made (streaming renew/close). */
  let settingsCalls = 0;
  const cardAt = (cardId: string) => cards[Number(cardId.slice("card_".length))];
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
    async getChatInfo(chatId: string) {
      return { chatId, name: "周末徒步", chatType: "group" };
    },
    rawClient: {
      cardkit: {
        v1: {
          card: {
            async create({ data }: { data: { data: string } }) {
              const spec = JSON.parse(data.data);
              cards.push({ replyTo: "", contents: [spec.body.elements[0].content], streaming: true, sequences: [] });
              return { code: 0, data: { card_id: `card_${cards.length - 1}` } };
            },
            async settings({
              path,
              data,
            }: {
              path: { card_id: string };
              data: { settings: string; sequence: number };
            }) {
              const card = cardAt(path.card_id);
              const { config } = JSON.parse(data.settings);
              card?.sequences.push(data.sequence);
              settingsCalls++;
              const fail = failSettings.shift() ?? 0;
              if (fail)
                throw Object.assign(new Error("Request failed with status code 400"), {
                  response: { data: { code: fail } },
                });
              if (card) card.streaming = config.streaming_mode;
              if (card && config.summary) card.summary = config.summary.content;
              return { code: 0, data: {} };
            },
            // A full card update replaces the JSON outright; it does not need streaming on.
            async update({
              path,
              data,
            }: {
              path: { card_id: string };
              data: { card: { type: string; data: string }; sequence: number };
            }) {
              const card = cardAt(path.card_id);
              card?.sequences.push(data.sequence);
              const code = failFinal.shift() ?? 0;
              if (code)
                throw Object.assign(new Error("Request failed with status code 400"), { response: { data: { code } } });
              const spec = JSON.parse(data.card.data);
              if (card) {
                card.streaming = spec.config.streaming_mode;
                if (spec.config.summary) card.summary = spec.config.summary.content;
                card.contents.push(spec.body.elements[0].content);
              }
              return { code: 0, data: {} };
            },
          },
          cardElement: {
            async content({ path, data }: { path: { card_id: string }; data: { content: string; sequence: number } }) {
              const card = cardAt(path.card_id);
              card?.sequences.push(data.sequence);
              const code = failUpdates.shift() ?? (card?.streaming ? 0 : 300309);
              // Feishu answers these with HTTP 400; the SDK's client throws with the body attached.
              if (code)
                throw Object.assign(new Error("Request failed with status code 400"), { response: { data: { code } } });
              card?.contents.push(data.content);
              return { code: 0, data: {} };
            },
          },
        },
      },
      im: {
        v1: {
          message: {
            async reply({
              path,
              data,
            }: {
              path: { message_id: string };
              data: { content: string; reply_in_thread?: boolean };
            }) {
              const card = cardAt(JSON.parse(data.content).data.card_id);
              if (card) {
                card.replyTo = path.message_id;
                if (data.reply_in_thread !== undefined) card.replyInThread = data.reply_in_thread;
              }
              return { code: 0, data: { message_id: "om_card" } };
            },
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
      async request({ url }: { url: string }) {
        if (url === "/open-apis/im/v1/chats/oc_1/members/bots")
          return { code: 0, data: { items: [{ bot_id: "ou_other_bot", bot_name: "值班机器人" }] } };
        throw new Error(`unexpected ${url}`);
      },
      contact: {
        v3: {
          user: {
            get: async ({ path }: { path: { user_id: string } }) => {
              contactGets.push(path.user_id);
              return {
                data: { user: { name: "李四", job_title: "产品经理", department_ids: ["od_pd", "od_gone"] } },
              };
            },
          },
          department: {
            get: async ({ path }: { path: { department_id: string } }) => {
              if (path.department_id !== "od_pd") throw Object.assign(new Error("no authority"), { code: 41050 });
              return { data: { department: { name: "产品部" } } };
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
    cards,
    failUpdates,
    failFinal,
    failSettings,
    settingsCalls: () => settingsCalls,
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
  onRegister?: (options: { appId: string | undefined; scopes: readonly string[] }) => void;
}): FeishuApi {
  return {
    async register({ appId, scopes, onQRCodeReady }) {
      options.onRegister?.({ appId, scopes });
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

  it("maps a message in a group's thread to a thread chat under the group (docs/spec.md 4.13)", () => {
    expect(
      toInbound(
        message({ threadId: "omt_1", rootId: "om_0", replyToMessageId: "om_0", mentionedBot: false }),
        bot,
        "周末徒步",
      ),
    ).toMatchObject({
      chat: {
        platformId: "oc_1:om_0",
        kind: "thread",
        parent: { platformId: "oc_1", name: "周末徒步" },
        followUp: true,
      },
      addressedToBot: false,
    });
    // A topic group's first message is a thread of its own.
    expect(toInbound(message({ threadId: "omt_2" }), bot, "话题群")?.chat.platformId).toBe("oc_1:om_1");
    expect(groupThread("oc_1:om_0")).toEqual({ chat: "oc_1", root: "om_0" });
    expect(groupThread("oc_1")).toBeUndefined();
    expect(groupThread("doc:docx:tok:c1")).toBeUndefined();
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

  it("retries botInfo transiently and keeps credentials when botInfo fails after QR creation (#199)", async () => {
    // Transient failure on the first botInfo call recovers on retry.
    let attempts = 0;
    const base = fakeApi({ activated: () => true });
    const recovering = feishuChannel({
      botInfoRetryMs: 1,
      api: {
        ...base,
        async botInfo(credentials) {
          attempts++;
          if (attempts === 1) throw new Error("Feishu /open-apis/bot/v3/info/ failed: bot not ready");
          return base.botInfo(credentials);
        },
      },
    });
    const recovered = await collect(recovering.onboard(undefined, new AbortController().signal, { agentName: "Alex" }));
    expect(attempts).toBe(2);
    expect(recovered.at(-1)).toMatchObject({
      kind: "succeeded",
      credentials: { appId: "cli_1", appSecret: "secret", domain: "feishu" },
      bot: { id: "ou_bot", name: "Alex" },
      pendingApproval: false,
    });

    // Even when botInfo keeps failing, onboarding does not crash or discard the created app.
    let persistentAttempts = 0;
    const failing = feishuChannel({
      botInfoRetryMs: 1,
      api: {
        ...base,
        async botInfo() {
          persistentAttempts++;
          throw new Error("Feishu /open-apis/bot/v3/info/ failed: 99991663");
        },
      },
    });
    const kept = await collect(failing.onboard(undefined, new AbortController().signal, { agentName: "Alex" }));
    expect(persistentAttempts).toBe(3);
    expect(kept.at(-1)).toEqual({
      kind: "succeeded",
      credentials: { appId: "cli_1", appSecret: "secret", domain: "feishu" },
      bot: { id: "cli_1", name: "Alex" },
      ownerId: "ou_owner",
      pendingApproval: true,
    });
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

  it("opens a thread under a message, talks in it, and sends the result to the chat itself (docs/spec.md 4.13)", async () => {
    const lark = fakeLark();
    const channel = feishuChannel({ api: fakeApi({ activated: () => true }), createChannel: () => lark.channel });
    const connection = await channel.connect(
      { appId: "cli_1", appSecret: "s" },
      { onMessage: () => {}, onState: () => {}, onMembership: () => {} },
    );
    expect(connection.capabilities().threads).toBe(true);
    const group = { platformId: "oc_1", kind: "group" as const, name: "周末徒步" };
    const opened = await connection.send({ chat: group, text: "收到", replyTo: "om_1", inThread: { title: "修登录" } });
    expect(opened).toMatchObject({
      kind: "sent",
      thread: {
        platformId: "oc_1:om_1",
        kind: "thread",
        parent: { platformId: "oc_1", name: "周末徒步" },
        followUp: true,
      },
    });
    expect(lark.sent.at(-1)).toMatchObject({ to: "oc_1", opts: { replyTo: "om_1", replyInThread: true } });
    // Into the thread: a reply to its root, in the thread.
    await connection.send({ chat: { platformId: "oc_1:om_1", kind: "thread" }, text: "原因找到了" });
    expect(lark.sent.at(-1)).toMatchObject({ to: "oc_1", opts: { replyTo: "om_1", replyInThread: true } });
    // The result: a reply to the root would land in its thread, so it is a message of its own.
    await connection.send({ chat: group, text: "修好了", replyTo: "om_1", inChat: true });
    expect(lark.sent.at(-1)).toMatchObject({ to: "oc_1", opts: {} });
    // Members of a thread are the group's.
    await connection.listMembers({ platformId: "oc_1:om_1", kind: "thread" });
    expect(lark.memberCalls.at(-1)?.chatId).toBe("oc_1");
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
      // Bots come from their own list.
      { id: "ou_other_bot", name: "值班机器人", isBot: true },
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

  it("asks for member profiles only when the owner turns them on, and keeps them on later scans", async () => {
    const asked: (readonly string[])[] = [];
    let granted = new Map<string, boolean>();
    const channel = feishuChannel({
      api: fakeApi({ activated: () => true, scopes: () => granted, onRegister: ({ scopes }) => asked.push(scopes) }),
    });
    const ctrl = new AbortController();
    const app = { appId: "cli_1", appSecret: "s" };
    await collect(channel.onboard(undefined, ctrl.signal, {}));
    await collect(channel.onboard(undefined, ctrl.signal, { reauthorize: app, adding: ["member_profiles"] }));
    granted = new Map(PROFILE_SCOPES.map((p) => [p, true]));
    await collect(channel.onboard(undefined, ctrl.signal, { reauthorize: app }));
    expect(asked[0]).toEqual(FEISHU_SCOPES);
    expect(asked[1]).toEqual([...FEISHU_SCOPES, ...PROFILE_SCOPES]);
    expect(asked[2]).toEqual([...FEISHU_SCOPES, ...PROFILE_SCOPES]);
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
        { id: "doc_comments", granted: false },
        { id: "member_profiles", granted: false, optional: true },
      ]);
      granted = new Map([[GROUP_MESSAGES_SCOPE, true]]);
      expect((await connection.permissions?.())?.[0]?.granted).toBe(false);
      clock.at += 20_000;
      // group_msg alone is not enough to hear other bots; both include_bot scopes count as one.
      expect(await connection.permissions?.()).toEqual([
        { id: "group_messages", granted: true },
        { id: "bot_messages", granted: false },
        { id: "doc_comments", granted: false },
        { id: "member_profiles", granted: false, optional: true },
      ]);
      // Member profiles stay off until asked for, and read nothing while off.
      expect(await connection.profile?.("ou_2")).toBeUndefined();
      clock.at += 20_000;
      granted = new Map([
        [GROUP_MESSAGES_SCOPE, true],
        [BOT_MESSAGES_SCOPES[0], true],
        [BOT_MESSAGES_SCOPES[1], true],
      ]);
      expect(await connection.permissions?.()).toEqual([
        { id: "group_messages", granted: true },
        { id: "bot_messages", granted: true },
        { id: "doc_comments", granted: false },
        { id: "member_profiles", granted: false, optional: true },
      ]);
      clock.at += 20_000;
      granted = new Map([...granted, ...PROFILE_SCOPES.map((p) => [p, true] as const)]);
      expect((await connection.permissions?.())?.[3]).toEqual({ id: "member_profiles", granted: true, optional: true });
      // A department outside the app's contact range is left out.
      expect(await connection.profile?.("ou_2")).toBe("产品部 · 产品经理");
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
    expect(lark.cards).toHaveLength(1);
    expect(lark.cards[0]).toMatchObject({
      replyTo: "om_1",
      contents: ["**正在思考** · 0 秒", "**正在处理** · 3 秒\n\n· 运行命令", "<at id=ou_asker></at> **周六**晴"],
      // Closed: no typing cursor, and the chat list previews the answer.
      streaming: false,
      summary: "**周六**晴",
    });
    expect(lark.cards[0]?.sequences).toEqual([1, 2]);
    await connection.close();
  });

  const liveCard = async () => {
    const lark = fakeLark();
    const channel = feishuChannel({ api: fakeApi({ activated: () => true }), createChannel: () => lark.channel });
    const connection = await channel.connect(
      { appId: "cli_1", appSecret: "s" },
      { onMessage: () => {}, onState: () => {}, onMembership: () => {} },
    );
    const live = await connection.startLive?.({ platformId: "oc_1", kind: "dm" }, { replyTo: "om_1", initial: "…" });
    return { lark, connection, live };
  };

  it("still writes the answer into the card after a progress update failed", async () => {
    const { lark, connection, live } = await liveCard();
    lark.failUpdates.push(230020);
    await live?.update("**正在处理** · 3 秒");
    await live?.update("**正在处理** · 4 秒");
    expect(await live?.finish("好了")).toEqual({ kind: "sent", platformId: "om_card" });
    expect(lark.cards[0]?.contents).toEqual(["…", "**正在处理** · 4 秒", "好了"]);
    await connection.close();
  });

  it("turns streaming back on when Feishu closed it, and keeps it on past ten minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { lark, connection, live } = await liveCard();
      // Feishu closed streaming on its own (the ten minutes ran out early, or a restart).
      lark.failUpdates.push(300309);
      await live?.update("**正在处理** · 9 分 0 秒");
      expect(lark.cards[0]?.contents.at(-1)).toBe("**正在处理** · 9 分 0 秒");
      // Long before Feishu's limit comes round again, the card renews streaming itself.
      vi.setSystemTime(Date.now() + 8 * 60_000 + 1);
      const settingsBefore = lark.cards[0]?.sequences.length ?? 0;
      await live?.update("**正在处理** · 17 分 0 秒");
      expect(lark.cards[0]?.sequences.length).toBe(settingsBefore + 2);
      expect(await live?.finish("一小时后的答案")).toMatchObject({ kind: "sent" });
      expect(lark.cards[0]?.contents.at(-1)).toBe("一小时后的答案");
      // Every operation on the card carried a larger sequence than the one before.
      const seq = lark.cards[0]?.sequences ?? [];
      expect(seq).toEqual([...seq].sort((a, b) => a - b));
      expect(new Set(seq).size).toBe(seq.length);
      await connection.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes the answer with one full card update even when streaming is already off", async () => {
    const { lark, connection, live } = await liveCard();
    // Feishu already turned streaming off; the final update must not reopen or close it.
    const card = lark.cards[0];
    if (card) card.streaming = false;
    const before = lark.settingsCalls();
    expect(await live?.finish("好了")).toMatchObject({ kind: "sent" });
    expect(lark.cards[0]?.contents.at(-1)).toBe("好了");
    expect(lark.settingsCalls()).toBe(before);
    await connection.close();
  });

  it("reports the answer as not sent when the card refuses it, so it goes out as a message", async () => {
    const { lark, connection, live } = await liveCard();
    lark.failFinal.push(200860); // Answer content rejected (e.g. too large for the card).
    expect(await live?.finish("好了")).toMatchObject({ kind: "failed" });
    expect(lark.cards[0]?.contents).toEqual(["…"]);
    // The card is still closed as best effort so it does not keep a typing cursor.
    expect(lark.cards[0]?.streaming).toBe(false);

    // An entity already past its 14 days refuses the update and the close alike: the finish
    // still reports failure without the cleanup throwing, so the answer goes out as a message.
    const second = await connection.startLive?.({ platformId: "oc_1", kind: "dm" }, { replyTo: "om_2", initial: "…" });
    lark.failFinal.push(200750);
    lark.failSettings.push(200750);
    expect(await second?.finish("晚了")).toMatchObject({ kind: "failed" });
    await connection.close();
  });

  it("bounds the calls a live card depends on, and nothing else", async () => {
    let http: LarkChannelOptions["httpInstance"];
    const channel = feishuChannel({
      api: fakeApi({ activated: () => true }),
      createChannel: (options) => {
        http = options.httpInstance;
        return fakeLark().channel;
      },
    });
    const connection = await channel.connect(
      { appId: "cli_1", appSecret: "s" },
      { onMessage: () => {}, onState: () => {}, onMembership: () => {} },
    );
    expect(http).toBeDefined();
    const request = vi.spyOn(sdk.defaultHttpInstance, "request").mockResolvedValue({ code: 0, data: {} });
    const post = vi.spyOn(sdk.defaultHttpInstance, "post").mockResolvedValue({ code: 0, data: {} });
    try {
      // The SDK resolves every call to an absolute URL before request().
      await http?.request({ url: "https://open.feishu.cn/open-apis/cardkit/v1/cards/card_1", method: "PUT" });
      expect(request.mock.lastCall?.[0]).toMatchObject({ timeout: 15_000 });
      await http?.request({
        url: "https://open.feishu.cn/open-apis/im/v1/messages/om_1/reply",
        method: "POST",
      });
      expect(request.mock.lastCall?.[0]).toMatchObject({ timeout: 15_000 });
      await http?.request({
        url: "https://open.larksuite.com/open-apis/im/v1/messages/om_1/reply",
        method: "POST",
      });
      expect(request.mock.lastCall?.[0]).toMatchObject({ timeout: 15_000 });
      // An explicit timeout always wins.
      await http?.request({
        url: "https://open.feishu.cn/open-apis/cardkit/v1/cards/card_1",
        method: "PUT",
        timeout: 1,
      });
      expect(request.mock.lastCall?.[0]).toMatchObject({ timeout: 1 });
      // Unrelated calls keep the SDK's unbounded behavior.
      await http?.request({ url: "https://open.feishu.cn/open-apis/im/v1/files/f1", method: "POST" });
      expect(request.mock.lastCall?.[0]?.timeout).toBeUndefined();
      await http?.post("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {});
      expect(post.mock.lastCall?.[2]).toMatchObject({ timeout: 15_000 });
      await http?.post("https://open.feishu.cn/open-apis/im/v1/messages", {});
      expect(post.mock.lastCall?.[2]?.timeout).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }
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

describe("feishu mentions (MING-107)", () => {
  const connect = async () => {
    const lark = fakeLark();
    const channel = feishuChannel({ api: fakeApi({ activated: () => true }), createChannel: () => lark.channel });
    const connection = await channel.connect(
      { appId: "cli_1", appSecret: "s" },
      { onMessage: () => {}, onState: () => {}, onMembership: () => {} },
    );
    return { lark, connection };
  };

  it("writes @name as a real mention in a post and in a live reply", async () => {
    const { lark, connection } = await connect();
    expect(connection.capabilities().mentions).toBe(true);
    const chat = { platformId: "oc_1", kind: "group" as const };
    const mentions = [{ id: "ou_pm", name: "Mingle产品经理" }];
    await connection.send({ chat, text: "@Mingle产品经理 想听你一句", mentions });
    expect(lark.sent[0]?.input).toEqual({ markdown: '<at user_id="ou_pm">Mingle产品经理</at> 想听你一句' });

    const live = await connection.startLive?.(chat, { replyTo: "om_1", mention: "ou_asker", initial: "…" });
    await live?.finish("@Mingle产品经理想听你一句", mentions);
    expect(lark.cards[0]?.contents.at(-1)).toBe("<at id=ou_asker></at> <at id=ou_pm></at>想听你一句");

    // The asker named in the answer is mentioned once, where the answer names them.
    const again = await connection.startLive?.(chat, { replyTo: "om_2", mention: "ou_asker", initial: "…" });
    await again?.finish("好的 @张三", [{ id: "ou_asker", name: "张三" }]);
    expect(lark.cards[1]?.contents.at(-1)).toBe("好的 <at id=ou_asker></at>");
    expect(lark.cards[1]?.replyInThread).toBeUndefined();

    // A live card inside a group thread replies in thread so it stays in that thread.
    const thread = { platformId: "oc_1:om_root", kind: "thread" as const };
    const inThread = await connection.startLive?.(thread, { replyTo: "om_3", mention: "ou_asker", initial: "…" });
    await inThread?.finish("Got it");
    expect(lark.cards[2]?.replyTo).toBe("om_3");
    expect(lark.cards[2]?.replyInThread).toBe(true);
    await connection.close();
  });

  it("reports the others a message mentions, so the agent can mention them back", () => {
    const inbound = toInbound(
      message({
        content: "@Bryce小跟班 你们聊几句",
        mentions: [
          { key: "@_user_1", openId: "ou_bot", name: "Alex", isBot: true },
          { key: "@_user_2", openId: "ou_other", name: "Bryce小跟班", isBot: false },
        ],
      }),
      bot,
      "群",
    );
    expect(inbound?.mentions).toEqual([{ id: "ou_other", name: "Bryce小跟班", isBot: false }]);
  });
});
