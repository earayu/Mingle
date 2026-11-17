import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import * as lark from "@larksuiteoapi/node-sdk";
import type {
  BotIdentity,
  BotPermission,
  Capabilities,
  Channel,
  ChannelConnection,
  ChannelEvents,
  ChatRef,
  Credentials,
  InboundAttachment,
  InboundMessage,
  LiveOptions,
  LiveReply,
  OnboardingContext,
  OnboardingEvent,
  OutboundMessage,
  ReactionState,
  SendResult,
} from "../channel.ts";
import { withTextSent } from "../channel.ts";

/**
 * Feishu (and Lark) through the official SDK: QR app registration, then a
 * long connection for events. No public callback address is needed.
 */

/**
 * Every message in the bot's groups, and the groups' earlier messages, the way a member sees them
 * (docs/spec.md 4.2). Sensitive on Feishu.
 */
export const GROUP_MESSAGES_SCOPE = "im:message.group_msg";

/**
 * What other bots say in the bot's groups: messages where users and other bots @ this bot, and
 * every group message from users and other bots (not this bot's own). Without these, Feishu pushes
 * nothing a bot sent. Self-built apps only.
 */
export const BOT_MESSAGES_SCOPES = [
  "im:message.group_at_msg.include_bot:readonly",
  "im:message.group_msg.include_bot:read",
] as const;

/**
 * Tenant scopes requested when the app is created: the same reach a person has in a chat. An app
 * created before `im:message.group_msg` was added gets it by scanning again from the bot's settings
 * page, which runs the update flow (docs/spec.md 6.1).
 */
export const FEISHU_SCOPES = [
  "im:message.p2p_msg:readonly",
  "im:message.group_at_msg:readonly",
  GROUP_MESSAGES_SCOPE,
  // A member sees what other bots say too (docs/spec.md 4.2 "机器人之间").
  ...BOT_MESSAGES_SCOPES,
  "im:message:readonly",
  "im:message:send_as_bot",
  "im:message.reactions:write_only",
  "im:resource",
  // Group info and the member list.
  "im:chat:readonly",
  // Display names of people who message the bot; Feishu events carry only their open_id.
  "contact:user.base:readonly",
];

const CAPABILITIES: Capabilities = {
  quoteReply: true,
  reactions: true,
  typingIndicator: false,
  fileUpload: true,
  fileDownload: true,
  listMembers: true,
  maxTextLength: 8000,
};

/** Streaming cards stop taking updates after about ten minutes; stay under it. */
const STREAM_LIMIT_MS = 9 * 60_000;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

/** How many of a group's latest messages to read when the bot joins: one page of Feishu's list. */
const HISTORY_LIMIT = 50;

/** How long a read of the app's granted scopes stays fresh. */
const SCOPES_TTL_MS = 15_000;

/** Feishu bot activate_status 2 means the tenant has the app enabled. Anything else waits for an admin. */
const ACTIVE = 2;

type Domain = "feishu" | "lark";

interface BotInfo {
  readonly name: string;
  readonly openId: string;
  readonly activated: boolean;
}

/** The HTTP calls the adapter makes outside LarkChannel. Injected so tests run offline. */
export interface FeishuApi {
  register(options: {
    signal: AbortSignal;
    agentName?: string;
    /** Re-authorize an existing app: the confirm page shows the permissions being added. */
    appId?: string;
    onQRCodeReady: (info: { url: string; expireIn: number }) => void;
  }): Promise<{ appId: string; appSecret: string; ownerId?: string; domain: Domain }>;
  botInfo(credentials: { appId: string; appSecret: string; domain: Domain }): Promise<BotInfo>;
  /** The scopes the app's published version asks for, each with whether the tenant granted it. */
  scopes(credentials: { appId: string; appSecret: string; domain: Domain }): Promise<ReadonlyMap<string, boolean>>;
}

export interface FeishuOptions {
  readonly api?: FeishuApi;
  /** How often to check whether an admin has approved the app. */
  readonly approvalPollMs?: number;
  readonly createChannel?: (options: lark.LarkChannelOptions) => LarkChannelLike;
}

/** The part of LarkChannel this adapter uses. */
export type LarkChannelLike = Pick<
  lark.LarkChannel,
  | "connect"
  | "disconnect"
  | "on"
  | "send"
  | "stream"
  | "addReaction"
  | "removeReaction"
  | "getChatInfo"
  | "rawClient"
  | "botIdentity"
>;

export function feishuChannel(options: FeishuOptions = {}): Channel {
  const api = options.api ?? officialApi();
  const pollMs = options.approvalPollMs ?? 30_000;
  const create = options.createChannel ?? ((o) => lark.createLarkChannel(o));

  return {
    platform: "feishu",
    // Only people in the organization can message the bot or add it to a group.
    trust: "org",
    // Scanning again with an app's credentials updates that app's permissions (registerApp appId).
    reauthorize: true,
    onboarding: { kind: "qr", desktopLink: true },
    manualSetupUrl: "https://open.feishu.cn/app",
    manualFields: [
      { key: "appId", labelKey: "feishu.appId", secret: false },
      { key: "appSecret", labelKey: "feishu.appSecret", secret: true },
    ],

    async *onboard(input, signal, context?: OnboardingContext): AsyncIterable<OnboardingEvent> {
      // Manual binding with an existing app: App ID + App Secret.
      if (input?.appId && input.appSecret) {
        const credentials = { appId: input.appId, appSecret: input.appSecret, domain: domainOf(input) };
        try {
          const bot = await api.botInfo(credentials);
          yield {
            kind: "succeeded",
            credentials,
            bot: { id: bot.openId, name: bot.name },
            pendingApproval: !bot.activated,
          };
        } catch {
          yield { kind: "failed", code: "invalid_credentials" };
        }
        return;
      }

      // QR registration. The SDK reports the QR through a callback; turn it into the event stream.
      const queue: OnboardingEvent[] = [];
      let wake: (() => void) | undefined;
      const push = (event: OnboardingEvent) => {
        queue.push(event);
        wake?.();
      };
      const done = api
        .register({
          signal,
          ...(context?.agentName ? { agentName: context.agentName } : {}),
          ...(context?.reauthorize?.appId ? { appId: context.reauthorize.appId } : {}),
          onQRCodeReady: ({ url, expireIn }) =>
            push({ kind: "qr_ready", qrContent: url, expiresAt: Date.now() + expireIn * 1000 }),
        })
        .then(
          async (result) => {
            const credentials = { appId: result.appId, appSecret: result.appSecret, domain: result.domain };
            const bot = await api.botInfo(credentials);
            push({
              kind: "succeeded",
              credentials,
              bot: { id: bot.openId, name: bot.name },
              ...(result.ownerId ? { ownerId: result.ownerId } : {}),
              pendingApproval: !bot.activated,
            });
          },
          (error: { code?: string }) => {
            const code =
              error?.code === "expired_token"
                ? "expired"
                : error?.code === "access_denied"
                  ? "denied"
                  : error?.code === "abort"
                    ? "cancelled"
                    : "network";
            push({ kind: "failed", code });
          },
        );
      for (;;) {
        while (queue.length > 0) {
          const event = queue.shift() as OnboardingEvent;
          yield event;
          if (event.kind === "succeeded" || event.kind === "failed") {
            await done;
            return;
          }
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },

    async connect(raw: Credentials, events: ChannelEvents): Promise<ChannelConnection> {
      const credentials = { appId: raw.appId ?? "", appSecret: raw.appSecret ?? "", domain: domainOf(raw) };
      let info = await api.botInfo(credentials);
      const bot: BotIdentity = { id: info.openId, name: info.name };
      let channel: LarkChannelLike | undefined;
      let closed = false;
      let approvalTimer: NodeJS.Timeout | undefined;
      const chatNames = new Map<string, string | undefined>();
      /** Reaction IDs of the processing emoji, so it can be swapped for DONE. */
      const reactions = new Map<string, string>();
      const userNames = new Map<string, string | undefined>();

      const userName = async (openId: string): Promise<string | undefined> => {
        if (!userNames.has(openId) && channel) {
          let name: string | undefined;
          try {
            const response = await channel.rawClient.contact.v3.user.get({
              path: { user_id: openId },
              params: { user_id_type: "open_id" },
            });
            name = response.data?.user?.name || undefined;
          } catch {
            // Missing contact permission or a network error: fall back to the open_id.
          }
          userNames.set(openId, name);
        }
        return userNames.get(openId);
      };

      const chatName = async (chatId: string): Promise<string | undefined> => {
        if (!chatNames.has(chatId) && channel) {
          const name = await channel
            .getChatInfo(chatId)
            .then((c) => c.name)
            .catch(() => undefined);
          chatNames.set(chatId, name);
        }
        return chatNames.get(chatId);
      };

      /** The group's latest messages, kept as background. Needs every-group-message access; without it, nothing. */
      const readEarlier = async (instance: LarkChannelLike, chatId: string, name: string | undefined) => {
        try {
          const response = await instance.rawClient.im.v1.message.list({
            params: {
              container_id_type: "chat",
              container_id: chatId,
              sort_type: "ByCreateTimeDesc",
              page_size: HISTORY_LIMIT,
            },
          });
          const botIdentity = instance.botIdentity ?? { openId: bot.id, name: bot.name };
          for (const item of [...(response.data?.items ?? [])].reverse()) {
            // The list names an app sender by its app ID, not the open_id live events use: skip our own.
            if (item.sender?.sender_type === "app" && item.sender.id === credentials.appId) continue;
            const raw = rawEvent(item, chatId);
            if (!raw) continue;
            const normalized = await lark.normalize(raw, { botIdentity, stripBotMentions: true });
            const app = item.sender?.sender_type === "app";
            const senderName = app ? undefined : await userName(normalized.senderId);
            const inbound = toInbound(senderName ? { ...normalized, senderName } : normalized, bot, name, app);
            if (inbound) events.onMessage({ ...inbound, earlier: true });
          }
        } catch {
          // Not allowed to read the group's messages, or offline: the bot starts from now.
        }
      };

      const start = async () => {
        const instance = create({
          appId: credentials.appId,
          appSecret: credentials.appSecret,
          domain: credentials.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
          transport: "websocket",
          loggerLevel: lark.LoggerLevel.warn,
          source: "mingle",
          // Mingle does its own batching and access rules. Group messages that do not @ the bot still
          // come through: the core keeps them as background (docs/spec.md 4.2).
          policy: { dmMode: "open", requireMention: false, respondToMentionAll: true },
          safety: { batch: { text: { delayMs: 0 }, media: { delayMs: 0 } } },
          // The SDK's duplicate check falls back to one process-wide cache keyed by message ID. Two
          // bots in one group get the same message ID, so whichever finished first made the other
          // drop the message as already seen. Each connection keeps its own.
          cache: new lark.DefaultCache(),
          // The event's sender_type marks other bots' messages (docs/spec.md 4.2 "怎么认出机器人").
          includeRawEvent: true,
        });
        channel = instance;
        instance.on("message", async (message) => {
          const isBot = (message.raw as lark.RawMessageEvent | undefined)?.sender?.sender_type === "app";
          // A contact lookup resolves only people; other bots stay unnamed.
          const senderName = message.senderName ?? (isBot ? undefined : await userName(message.senderId));
          const inbound = toInbound(
            senderName ? { ...message, senderName } : message,
            bot,
            message.chatType === "group" ? await chatName(message.chatId) : undefined,
            isBot,
          );
          if (inbound) events.onMessage(inbound);
        });
        instance.on("botAdded", async (event) => {
          const name = await chatName(event.chatId);
          events.onMembership({
            chat: { platformId: event.chatId, kind: "group", ...(name ? { name } : {}) },
            joined: true,
          });
          // Like a person who joins: scroll up and see what was said before (docs/spec.md 4.2).
          await readEarlier(instance, event.chatId, name);
        });
        instance.on("reconnecting", () => events.onState({ kind: "reconnecting", attempt: 1 }));
        instance.on("reconnected", () => events.onState({ kind: "connected" }));
        await instance.connect();
        events.onState({ kind: "connected" });
      };

      if (info.activated) {
        await start();
      } else {
        // The app exists but the tenant has not enabled it yet. Check until an admin approves.
        events.onState({ kind: "awaiting_approval" });
        const check = async () => {
          if (closed) return;
          try {
            info = await api.botInfo(credentials);
            if (info.activated) {
              await start();
              return;
            }
          } catch {}
          approvalTimer = setTimeout(check, pollMs);
        };
        approvalTimer = setTimeout(check, pollMs);
      }

      let scopes: { at: number; read: Promise<readonly BotPermission[]> } | undefined;
      const readPermissions = async (): Promise<readonly BotPermission[]> => {
        try {
          const granted = await api.scopes(credentials);
          // Both granted by scanning again from the bot's settings (`reauthorize`), not on Feishu's site.
          return [
            { id: "group_messages", granted: granted.get(GROUP_MESSAGES_SCOPE) === true },
            { id: "bot_messages", granted: BOT_MESSAGES_SCOPES.every((s) => granted.get(s) === true) },
          ];
        } catch {
          return [];
        }
      };

      return {
        bot,
        capabilities: () => CAPABILITIES,

        permissions() {
          if (!scopes || Date.now() - scopes.at > SCOPES_TTL_MS) scopes = { at: Date.now(), read: readPermissions() };
          return scopes.read;
        },

        async send(message: OutboundMessage): Promise<SendResult> {
          if (!channel) return { kind: "failed", code: "forbidden", retryable: false };
          const opts = message.replyTo ? { replyTo: message.replyTo } : {};
          let textId = "";
          try {
            let last = "";
            if (message.text)
              last = textId = (await channel.send(message.chat.platformId, { markdown: message.text }, opts)).messageId;
            for (const file of message.files ?? []) {
              const source = await readFile(file.path);
              const name = file.name ?? basename(file.path);
              const input = IMAGE_EXTENSIONS.has(extname(name).toLowerCase())
                ? { image: { source } }
                : { file: { source, fileName: name } };
              last = (await channel.send(message.chat.platformId, input, opts)).messageId;
            }
            // Sent to a person by their open_id (openDirect): learn the direct chat's own ID.
            if (message.chat.platformId.startsWith("ou_")) {
              const chat = await channel.rawClient.im.v1.message
                .get({ path: { message_id: last } })
                .then((r) => r.data?.items?.[0]?.chat_id)
                .catch(() => undefined);
              if (chat) return { kind: "sent", platformId: last, chat };
            }
            return { kind: "sent", platformId: last };
          } catch (error) {
            return withTextSent(sendFailure(error), textId);
          }
        },

        async react(_chat: ChatRef, platformMessageId: string, state: ReactionState) {
          if (!channel) return;
          // Feishu's own emoji: OnIt while working, DONE once answered, ERROR on failure.
          const previous = reactions.get(platformMessageId);
          if (previous) {
            reactions.delete(platformMessageId);
            await channel.removeReaction(platformMessageId, previous).catch(() => {});
          }
          const emoji = { processing: "OnIt", done: "DONE", error: "ERROR", none: null }[state];
          if (!emoji) return;
          const id = await channel.addReaction(platformMessageId, emoji).catch(() => undefined);
          if (id && state === "processing") reactions.set(platformMessageId, id);
        },

        async startLive(chat: ChatRef, options: LiveOptions): Promise<LiveReply> {
          if (!channel) throw new Error("the Feishu connection is not ready");
          const startedAt = Date.now();
          let controller: lark.MarkdownStreamController | undefined;
          let release: () => void = () => {};
          const released = new Promise<void>((resolve) => {
            release = resolve;
          });
          const ready = Promise.withResolvers<void>();
          // The SDK keeps a streaming card open while the producer runs; ours runs until finish().
          const stream = channel
            .stream(
              chat.platformId,
              {
                markdown: async (c) => {
                  controller = c;
                  await c.setContent(options.initial);
                  ready.resolve();
                  await released;
                },
              },
              { replyTo: options.replyTo },
            )
            .catch((error) => {
              ready.reject(error);
              throw error;
            });
          await ready.promise;
          const mention = options.mention ? `<at id=${options.mention}></at> ` : "";
          return {
            update: async (markdown) => {
              await controller?.setContent(markdown).catch(() => {});
            },
            finish: async (markdown) => {
              // Feishu stops accepting updates to a streaming card after about ten minutes.
              if (Date.now() - startedAt > STREAM_LIMIT_MS) {
                release();
                await stream.catch(() => {});
                return { kind: "failed", code: "unknown", retryable: false };
              }
              await controller?.setContent(`${mention}${markdown}`);
              release();
              const result = await stream;
              return { kind: "sent", platformId: result.messageId };
            },
          };
        },

        async setTyping() {},

        async download(attachment: InboundAttachment, toPath: string) {
          if (!channel) throw new Error("the Feishu connection is not ready");
          const [messageId, type, fileKey] = attachment.id.split("|");
          const response = await channel.rawClient.im.v1.messageResource.get({
            path: { message_id: messageId ?? "", file_key: fileKey ?? "" },
            params: { type: type === "image" ? "image" : "file" },
          });
          await response.writeFile(toPath);
        },

        async listMembers(chat: ChatRef) {
          if (!channel) return [];
          const members: { id: string; name: string; isBot: boolean }[] = [];
          try {
            let pageToken: string | undefined;
            for (let page = 0; page < 10; page++) {
              const response = await channel.rawClient.im.v1.chatMembers.get({
                path: { chat_id: chat.platformId },
                params: { member_id_type: "open_id", page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
              });
              for (const item of response.data?.items ?? []) {
                members.push({ id: item.member_id ?? "", name: item.name ?? "", isBot: false });
              }
              if (!response.data?.has_more || !response.data.page_token) break;
              pageToken = response.data.page_token;
            }
          } catch {
            // Not in the chat, a missing im:chat:readonly grant, or a network error: report nobody.
            return [];
          }
          return members;
        },

        // A bot can write to anyone in its availability range; the chat gets its ID with the first message.
        async openDirect(userId: string) {
          return userId;
        },

        async messageUser(userId: string, text: string) {
          if (!channel) throw new Error("the Feishu connection is not ready");
          await channel.rawClient.im.v1.message.create({
            params: { receive_id_type: "open_id" },
            data: { receive_id: userId, msg_type: "text", content: JSON.stringify({ text }) },
          });
        },

        async close() {
          closed = true;
          clearTimeout(approvalTimer);
          await channel?.disconnect().catch(() => {});
        },
      };
    },
  };
}

/** One item of Feishu's message list in the shape of a receive event, for the SDK's normalizer. */
type ListedMessage = NonNullable<
  NonNullable<Awaited<ReturnType<lark.Client["im"]["v1"]["message"]["list"]>>["data"]>["items"]
>[number];

/** Exported for tests. */
export function rawEvent(item: ListedMessage, chatId: string): lark.RawMessageEvent | undefined {
  if (item.deleted || !item.message_id || !item.msg_type || !item.sender?.id) return undefined;
  // System messages (someone joined, the name changed) are not part of the conversation.
  if (item.msg_type === "system") return undefined;
  return {
    sender: {
      sender_id: { open_id: item.sender.id },
      sender_type: item.sender.sender_type,
      ...(item.sender.tenant_key ? { tenant_key: item.sender.tenant_key } : {}),
    },
    message: {
      message_id: item.message_id,
      ...(item.root_id ? { root_id: item.root_id } : {}),
      ...(item.parent_id ? { parent_id: item.parent_id } : {}),
      ...(item.thread_id ? { thread_id: item.thread_id } : {}),
      ...(item.create_time ? { create_time: item.create_time } : {}),
      chat_id: item.chat_id ?? chatId,
      chat_type: "group",
      message_type: item.msg_type,
      content: item.body?.content ?? "",
      mentions: (item.mentions ?? []).map((m) => ({ key: m.key, id: { open_id: m.id }, name: m.name })),
    },
  };
}

function domainOf(credentials: Credentials): Domain {
  return credentials.domain === "lark" ? "lark" : "feishu";
}

function originOf(domain: Domain): string {
  return domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

/** Map a normalized Feishu message to Mingle's shape. Exported for tests. */
export function toInbound(
  message: lark.NormalizedMessage,
  bot: BotIdentity,
  chatName: string | undefined,
  isBot = false,
): InboundMessage | undefined {
  if (message.senderId === bot.id) return undefined;
  const dm = message.chatType === "p2p";
  // The SDK strips mentions of this bot; also drop a leftover "@Name" if a client typed it as text.
  let text = message.content;
  if (bot.name) text = text.replaceAll(`@${bot.name}`, "");
  text = text.replace(/[ \t]{2,}/g, " ").trim();

  const attachments: InboundAttachment[] = message.resources.map((r, i) => ({
    // messageResource.get needs the message and the key; keep both in the handle.
    id: `${message.messageId}|${r.type}|${r.fileKey}`,
    name: r.fileName ?? `${r.type}-${i + 1}${r.type === "image" ? ".png" : ""}`,
    ...(r.type === "image" ? { mime: "image/png" } : {}),
  }));

  return {
    platformId: message.messageId,
    chat: {
      platformId: message.chatId,
      kind: dm ? "dm" : "group",
      ...(dm ? (message.senderName ? { name: message.senderName } : {}) : chatName ? { name: chatName } : {}),
    },
    // An empty name means unknown; the console labels such senders without showing the open_id.
    sender: { id: message.senderId, name: message.senderName ?? "", isBot },
    text,
    attachments,
    ...(message.replyToMessageId ? { replyTo: message.replyToMessageId } : {}),
    addressedToBot: dm || message.mentionedBot,
    mentioned: message.mentionedBot,
    sentAt: message.createTime,
  };
}

function sendFailure(error: unknown): SendResult {
  const code = (error as { code?: string })?.code;
  switch (code) {
    case "rate_limited":
      return { kind: "failed", code: "rate_limited", retryable: true };
    case "permission_denied":
      return { kind: "failed", code: "forbidden", retryable: false };
    case "target_revoked":
      return { kind: "failed", code: "chat_gone", retryable: false };
    case "upload_failed":
      return { kind: "failed", code: "too_large", retryable: false };
    case "not_connected":
      return { kind: "failed", code: "network", retryable: true };
    case "send_timeout":
      // The request may have gone through.
      return { kind: "uncertain" };
    default:
      return { kind: "failed", code: "unknown", retryable: false };
  }
}

function officialApi(): FeishuApi {
  return {
    async register({ signal, agentName, appId, onQRCodeReady }) {
      const result = await lark.registerApp({
        source: "mingle",
        signal,
        // Updating an existing app: the confirm page shows only the added permissions.
        ...(appId
          ? { appId }
          : {
              createOnly: true,
              appPreset: {
                name: agentName ? `${agentName}` : "Mingle Agent",
                desc: "An agent that lives in your chats, run by Mingle on its owner's computer.",
              },
            }),
        addons: {
          scopes: { tenant: [...FEISHU_SCOPES] },
          events: { items: { tenant: ["im.message.receive_v1", "im.chat.member.bot.added_v1"] } },
        },
        onQRCodeReady,
      });
      return {
        appId: result.client_id,
        appSecret: result.client_secret,
        domain: result.user_info?.tenant_brand === "lark" ? "lark" : "feishu",
        ...(result.user_info?.open_id ? { ownerId: result.user_info.open_id } : {}),
      };
    },

    async botInfo(credentials) {
      const body = await feishuGet<{ bot?: { app_name?: string; open_id?: string; activate_status?: number } }>(
        credentials,
        "/open-apis/bot/v3/info/",
      );
      return {
        name: body.bot?.app_name ?? "Feishu bot",
        openId: body.bot?.open_id ?? credentials.appId,
        activated: body.bot?.activate_status === ACTIVE,
      };
    },

    async scopes(credentials) {
      // Needs no scope of its own. grant_status 1 is granted, 2 is not yet.
      const body = await feishuGet<{ data?: { scopes?: { scope_name?: string; grant_status?: number }[] } }>(
        credentials,
        "/open-apis/application/v6/scopes",
      );
      return new Map((body.data?.scopes ?? []).map((s) => [s.scope_name ?? "", s.grant_status === 1]));
    },
  };
}

/** A GET with a fresh tenant token. Throws on any non-zero Feishu code. */
async function feishuGet<T>(
  { appId, appSecret, domain }: { appId: string; appSecret: string; domain: Domain },
  path: string,
): Promise<T> {
  const origin = originOf(domain);
  const tokenResponse = await fetch(`${origin}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(15_000),
  });
  const token = (await tokenResponse.json()) as { code: number; msg?: string; tenant_access_token?: string };
  if (token.code !== 0 || !token.tenant_access_token) throw new Error(`Feishu auth failed: ${token.msg ?? token.code}`);
  const response = await fetch(`${origin}${path}`, {
    headers: { authorization: `Bearer ${token.tenant_access_token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json()) as T & { code: number; msg?: string };
  if (body.code !== 0) throw new Error(`Feishu ${path} failed: ${body.msg ?? body.code}`);
  return body;
}
