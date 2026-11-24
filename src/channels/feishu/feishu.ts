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
import { type Mention, renderMentions } from "../mention.ts";
import {
  type CommentThread,
  commentInbound,
  DOC_COMMENT_EVENT,
  DOC_COMMENT_SCOPES,
  DOC_META_SCOPE,
  parseThread,
  ShownReplies,
  sendReply,
} from "./comments.ts";

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
  // A document is a group too: @ the bot in a comment and it answers in the thread (docs/spec.md 6.8).
  ...DOC_COMMENT_SCOPES,
  DOC_META_SCOPE,
];

/**
 * Asked for only when the owner turns member profiles on from the bot's settings (docs/spec.md
 * 4.2, 6.1): reading a user or a department at all, then the title, the departments, and their
 * names. Email and phone stay out. Checked against Feishu's docs for contact-v3 user/get and
 * department/get; the data is limited to the app's contact range.
 */
export const PROFILE_SCOPES = [
  "contact:contact.base:readonly",
  "contact:user.employee:readonly",
  "contact:user.department:readonly",
  "contact:department.base:readonly",
];

const CAPABILITIES: Capabilities = {
  quoteReply: true,
  reactions: true,
  typingIndicator: false,
  fileUpload: true,
  fileDownload: true,
  listMembers: true,
  mentions: true,
  // "Reply in thread" (im.v1.message.reply, reply_in_thread) opens a thread under a group message.
  threads: true,
  maxTextLength: 8000,
};

/**
 * A thread in a group (docs/spec.md 4.13): `<chat_id>:<root message id>`. Feishu sends into it by
 * replying to a message in it with reply_in_thread; the root is one that always is.
 */
export function groupThread(platformId: string): { chat: string; root: string } | undefined {
  if (platformId.startsWith("doc:")) return undefined;
  const at = platformId.indexOf(":");
  return at > 0 ? { chat: platformId.slice(0, at), root: platformId.slice(at + 1) } : undefined;
}

/**
 * Feishu turns a card's streaming mode off ten minutes after it was last turned on (error 300309
 * or 200850 after that). A reply open longer turns it on again before then, and once more if an
 * update finds it closed. The card itself stays editable for 14 days.
 */
const STREAM_RENEW_MS = 8 * 60_000;
const STREAM_CLOSED = new Set([300309, 200850]);
/** The SDK's axios instance has no default timeout; bound the calls a live card depends on. */
const REQUEST_TIMEOUT_MS = 15_000;
const CARD_ELEMENT = "stream_md";

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
    /** Tenant scopes to ask for. */
    scopes: readonly string[];
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
  /** Delay between retries when bot/v3/info fails immediately after QR app creation. */
  readonly botInfoRetryMs?: number;
  readonly createChannel?: (options: lark.LarkChannelOptions) => LarkChannelLike;
}

/** The part of LarkChannel this adapter uses. */
export type LarkChannelLike = Pick<
  lark.LarkChannel,
  | "connect"
  | "disconnect"
  | "on"
  | "send"
  | "addReaction"
  | "removeReaction"
  | "getChatInfo"
  | "rawClient"
  | "botIdentity"
>;

export function feishuChannel(options: FeishuOptions = {}): Channel {
  const api = options.api ?? officialApi();
  const pollMs = options.approvalPollMs ?? 30_000;
  const botInfoRetryMs = options.botInfoRetryMs ?? 1_000;
  const create = options.createChannel ?? ((o) => lark.createLarkChannel(o));

  return {
    platform: "feishu",
    groupMessages: true,
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

      // What to ask for: the base set, and member profiles when the owner is turning them on now
      // or the app already has them (a later scan never drops what was granted).
      let scopes: readonly string[] = FEISHU_SCOPES;
      const updating = context?.reauthorize;
      let profiles = context?.adding?.includes("member_profiles") ?? false;
      if (!profiles && updating?.appId && updating.appSecret) {
        const granted = await api
          .scopes({ appId: updating.appId, appSecret: updating.appSecret, domain: domainOf(updating) })
          .catch(() => new Map<string, boolean>());
        profiles = PROFILE_SCOPES.every((scope) => granted.get(scope) === true);
      }
      if (profiles) scopes = [...FEISHU_SCOPES, ...PROFILE_SCOPES];

      // QR registration. The SDK reports the QR through a callback; turn it into the event stream.
      const queue: OnboardingEvent[] = [];
      let wake: (() => void) | undefined;
      const push = (event: OnboardingEvent) => {
        queue.push(event);
        wake?.();
      };
      const done = (async () => {
        try {
          const result = await api.register({
            signal,
            ...(context?.agentName ? { agentName: context.agentName } : {}),
            ...(context?.reauthorize?.appId ? { appId: context.reauthorize.appId } : {}),
            scopes,
            onQRCodeReady: ({ url, expireIn }) =>
              push({ kind: "qr_ready", qrContent: url, expiresAt: Date.now() + expireIn * 1000 }),
          });
          const credentials = { appId: result.appId, appSecret: result.appSecret, domain: result.domain };
          // Right after QR app creation, bot/v3/info can transiently fail while Feishu finishes
          // provisioning the bot (or while the tenant has not activated it yet). Retry briefly,
          // and if it still fails keep the created credentials instead of crashing or discarding
          // them, so Mingle saves the connection and retries instead of leaving orphaned bots.
          let bot: BotInfo | undefined;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              bot = await api.botInfo(credentials);
              break;
            } catch {
              if (signal.aborted || attempt === 2) break;
              await wait(botInfoRetryMs, signal);
            }
          }
          push({
            kind: "succeeded",
            credentials,
            bot: { id: bot?.openId ?? credentials.appId, name: bot?.name ?? context?.agentName ?? "Feishu bot" },
            ...(result.ownerId ? { ownerId: result.ownerId } : {}),
            pendingApproval: !(bot?.activated ?? false),
          });
        } catch (error) {
          const code =
            signal.aborted || (error as { code?: string })?.code === "abort"
              ? "cancelled"
              : (error as { code?: string })?.code === "expired_token"
                ? "expired"
                : (error as { code?: string })?.code === "access_denied"
                  ? "denied"
                  : "network";
          push({ kind: "failed", code });
        }
      })();
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
      /** Replies of each document comment thread the agent has been shown (docs/spec.md 6.8). */
      const shown = new ShownReplies();
      const docMetas = new Map<string, Promise<{ title?: string; url?: string }>>();

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

      /** A document's title and link, read once per run. Without the metadata scope, neither. */
      const docMeta = (thread: CommentThread): Promise<{ title?: string; url?: string }> => {
        let meta = docMetas.get(thread.fileToken);
        if (!meta) {
          const client = channel?.rawClient;
          meta = client
            ? client.drive.v1.meta
                .batchQuery({
                  data: {
                    request_docs: [{ doc_token: thread.fileToken, doc_type: thread.fileType as "docx" }],
                    with_url: true,
                  },
                })
                .then((r) => {
                  const found = r.data?.metas?.[0];
                  return { ...(found?.title ? { title: found.title } : {}), ...(found?.url ? { url: found.url } : {}) };
                })
                .catch(() => ({}))
            : Promise.resolve({});
          docMetas.set(thread.fileToken, meta);
        }
        return meta;
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
          httpInstance: boundedHttp(lark.defaultHttpInstance as unknown as LarkHttp),
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
        // An @ in a document's comments, or a new reply in a thread the bot is part of (docs/spec.md 6.8).
        instance.on("comment", async (event) => {
          const inbound = await commentInbound({
            event,
            bot,
            client: instance.rawClient,
            shown,
            name: userName,
            meta: docMeta,
          }).catch(() => undefined);
          if (inbound) events.onMessage(inbound);
        });
        instance.on("reconnecting", () => events.onState({ kind: "reconnecting", attempt: 1 }));
        instance.on("reconnected", () => events.onState({ kind: "connected" }));
        await instance.connect();
        if (closed) {
          await instance.disconnect().catch(() => {});
          return;
        }
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
            if (closed) return;
            if (info.activated) {
              await start();
              return;
            }
          } catch {}
          if (!closed) approvalTimer = setTimeout(check, pollMs);
        };
        approvalTimer = setTimeout(check, pollMs);
      }

      let scopes: { at: number; read: Promise<readonly BotPermission[]> } | undefined;
      const readPermissions = async (): Promise<readonly BotPermission[]> => {
        try {
          const granted = await api.scopes(credentials);
          // Granted by scanning again from the bot's settings (`reauthorize`), not on Feishu's site.
          return [
            { id: "group_messages", granted: granted.get(GROUP_MESSAGES_SCOPE) === true },
            { id: "bot_messages", granted: BOT_MESSAGES_SCOPES.every((s) => granted.get(s) === true) },
            { id: "doc_comments", granted: DOC_COMMENT_SCOPES.every((s) => granted.get(s) === true) },
            {
              id: "member_profiles",
              granted: PROFILE_SCOPES.every((scope) => granted.get(scope) === true),
              optional: true,
            },
          ];
        } catch {
          return [];
        }
      };
      const permissions = (): Promise<readonly BotPermission[]> => {
        if (!scopes || Date.now() - scopes.at > SCOPES_TTL_MS) scopes = { at: Date.now(), read: readPermissions() };
        return scopes.read;
      };
      const departments = new Map<string, Promise<string | undefined>>();
      const department = (id: string): Promise<string | undefined> => {
        let name = departments.get(id);
        if (!name) {
          name = (channel as LarkChannelLike).rawClient.contact.v3.department
            .get({ path: { department_id: id }, params: { department_id_type: "open_department_id" } })
            .then((r) => r.data?.department?.name || undefined)
            .catch(() => undefined);
          departments.set(id, name);
        }
        return name;
      };

      return {
        bot,
        capabilities: () => CAPABILITIES,

        permissions,

        async profile(userId: string) {
          if (!channel) return undefined;
          const on = (await permissions()).some((p) => p.id === "member_profiles" && p.granted);
          if (!on) return undefined;
          try {
            const response = await channel.rawClient.contact.v3.user.get({
              path: { user_id: userId },
              params: { user_id_type: "open_id", department_id_type: "open_department_id" },
            });
            const user = response.data?.user;
            const names = await Promise.all((user?.department_ids ?? []).slice(0, 3).map(department));
            const where = names.filter(Boolean).join(", ");
            return [where, user?.job_title?.trim()].filter(Boolean).join(" · ") || undefined;
          } catch {
            // Outside the app's contact range, or offline.
            return undefined;
          }
        },

        async send(message: OutboundMessage): Promise<SendResult> {
          if (!channel) return { kind: "failed", code: "forbidden", retryable: false };
          const thread = parseThread(message.chat.platformId);
          if (thread) {
            const result = await sendReply(channel.rawClient, thread, message);
            if (result.kind === "sent") shown.add(message.chat.platformId, result.platformId);
            return result;
          }
          const inGroupThread = groupThread(message.chat.platformId);
          const chatId = inGroupThread?.chat ?? message.chat.platformId;
          // Into a thread: a reply in it. Opening one: a reply in a thread under the message. The
          // outcome for the whole chat: a message of its own, as a reply to a message with a thread
          // under it lands in that thread (Feishu's reply_in_thread notes).
          const opts = inGroupThread
            ? { replyTo: message.replyTo ?? inGroupThread.root, replyInThread: true }
            : message.replyTo && message.inChat
              ? {}
              : message.replyTo
                ? { replyTo: message.replyTo, ...(message.inThread ? { replyInThread: true } : {}) }
                : {};
          const opened: ChatRef | undefined =
            !inGroupThread && message.replyTo && message.inThread && !message.inChat
              ? {
                  platformId: `${message.chat.platformId}:${message.replyTo}`,
                  kind: "thread",
                  parent: {
                    platformId: message.chat.platformId,
                    ...(message.chat.name ? { name: message.chat.name } : {}),
                  },
                  followUp: true,
                }
              : undefined;
          let textId = "";
          try {
            let last = "";
            if (message.text)
              last = textId = (
                await channel.send(chatId, { markdown: postMentions(message.text, message.mentions) }, opts)
              ).messageId;
            for (const file of message.files ?? []) {
              const source = await readFile(file.path);
              const name = file.name ?? basename(file.path);
              const input = IMAGE_EXTENSIONS.has(extname(name).toLowerCase())
                ? { image: { source } }
                : { file: { source, fileName: name } };
              last = (await channel.send(chatId, input, opts)).messageId;
            }
            // Sent to a person by their open_id (openDirect): learn the direct chat's own ID.
            if (message.chat.platformId.startsWith("ou_")) {
              const chat = await channel.rawClient.im.v1.message
                .get({ path: { message_id: last } })
                .then((r) => r.data?.items?.[0]?.chat_id)
                .catch(() => undefined);
              if (chat) return { kind: "sent", platformId: last, chat };
            }
            return { kind: "sent", platformId: last, ...(opened ? { thread: opened } : {}) };
          } catch (error) {
            return withTextSent(sendFailure(error), textId);
          }
        },

        async react(chat: ChatRef, platformMessageId: string, state: ReactionState) {
          // A comment reply has no reaction a bot can add: the answer itself shows it was heard.
          if (!channel || parseThread(chat.platformId)) return;
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
          // A comment thread takes no cards: the answer goes out as a reply of its own.
          if (parseThread(chat.platformId)) throw new Error("a document comment cannot be a live reply");
          const card = await openCard(
            channel.rawClient,
            options.replyTo,
            options.initial,
            Boolean(groupThread(chat.platformId)),
          );
          const mention = options.mention ? `<at id=${options.mention}></at> ` : "";
          return {
            update: async (markdown) => {
              await card.push(markdown).catch(() => {});
            },
            finish: async (markdown, mentions) => {
              // The asker is mentioned up front, unless the answer already names them.
              const lead = mentions?.some((m) => m.id === options.mention) ? "" : mention;
              const text = `${lead}${renderMentions(markdown, mentions, (m) => `<at id=${m.id}></at>`)}`;
              try {
                await card.finish(text);
              } catch {
                // The card refused the answer; the outbox sends it as a message of its own.
                return { kind: "failed", code: "unknown", retryable: false };
              }
              return { kind: "sent", platformId: card.messageId };
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
          if (!channel || parseThread(chat.platformId)) return [];
          const members: { id: string; name: string; isBot: boolean }[] = [];
          try {
            let pageToken: string | undefined;
            for (let page = 0; page < 10; page++) {
              const response = await channel.rawClient.im.v1.chatMembers.get({
                path: { chat_id: groupThread(chat.platformId)?.chat ?? chat.platformId },
                params: { member_id_type: "open_id", page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
              });
              for (const item of response.data?.items ?? []) {
                members.push({ id: item.member_id ?? "", name: item.name ?? "", isBot: false });
              }
              if (!response.data?.has_more || !response.data.page_token) break;
              pageToken = response.data.page_token;
            }
            // The member list leaves bots out; Feishu lists them separately (im:chat:readonly).
            const raw = channel.rawClient;
            // People are listed even when the bots cannot be.
            const bots = await (async () =>
              raw.request<{ data?: { items?: { bot_id?: string; bot_name?: string }[] } }>({
                method: "GET",
                url: `/open-apis/im/v1/chats/${encodeURIComponent(groupThread(chat.platformId)?.chat ?? chat.platformId)}/members/bots`,
              }))().catch(() => undefined);
            for (const item of bots?.data?.items ?? []) {
              if (item.bot_id) members.push({ id: item.bot_id, name: item.bot_name ?? "", isBot: true });
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
          const sent = await channel.rawClient.im.v1.message.create({
            params: { receive_id_type: "open_id" },
            data: { receive_id: userId, msg_type: "text", content: JSON.stringify({ text }) },
          });
          const chat = sent.data?.chat_id;
          return chat ? { chat, ...(sent.data?.message_id ? { platformId: sent.data.message_id } : {}) } : undefined;
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

  const others = message.mentions
    .filter((m) => m.openId && !m.isBot && m.openId !== bot.id)
    .map((m) => ({ id: m.openId as string, name: m.name ?? "", isBot: false }));

  // A message in a group's thread: the thread is a chat of its own, under the group, and one
  // conversation (docs/spec.md 4.13). Its root is the message the thread was opened under.
  const chat: ChatRef =
    !dm && message.threadId
      ? {
          platformId: `${message.chatId}:${message.rootId ?? message.messageId}`,
          kind: "thread",
          parent: { platformId: message.chatId, ...(chatName ? { name: chatName } : {}) },
          followUp: true,
        }
      : {
          platformId: message.chatId,
          kind: dm ? "dm" : "group",
          ...(dm ? (message.senderName ? { name: message.senderName } : {}) : chatName ? { name: chatName } : {}),
        };
  return {
    platformId: message.messageId,
    chat,
    // An empty name means unknown; the console labels such senders without showing the open_id.
    sender: { id: message.senderId, name: message.senderName ?? "", isBot },
    text,
    attachments,
    ...(message.replyToMessageId ? { replyTo: message.replyToMessageId } : {}),
    addressedToBot: dm || message.mentionedBot,
    mentioned: message.mentionedBot,
    ...(others.length ? { mentions: others } : {}),
    sentAt: message.createTime,
  };
}

/** `@name` as a post's `md` element writes a mention. */
function postMentions(markdown: string, mentions: readonly Mention[] | undefined): string {
  return renderMentions(markdown, mentions, (m) => `<at user_id="${m.id}">${m.name}</at>`);
}

type LarkClient = LarkChannelLike["rawClient"];

type LarkHttp = NonNullable<lark.LarkChannelOptions["httpInstance"]>;

/**
 * The SDK's axios instance is created without a timeout, so a hung request (a stalled CardKit
 * write, a dead token refresh) would wait forever — and for a live card, block the answer behind
 * it. Only the calls the card depends on are bounded: every CardKit operation, the reply that
 * sends the card, and the tenant-token refresh those need first. Everything else (file up- and
 * downloads, message lists, contacts) keeps the SDK's unbounded behavior, and an explicit
 * timeout in the request options always wins. The default instance's interceptors and response
 * shape are preserved by delegating to its own methods.
 */
function boundedHttp(base: LarkHttp): LarkHttp {
  const bound = (url: string) =>
    // The SDK resolves options.url to an absolute URL (https://open.feishu.cn/...) before request().
    url.includes("/open-apis/cardkit/v1/cards") || /\/open-apis\/im\/v1\/messages\/[^/]+\/reply$/.test(url);
  return {
    ...base,
    request: <T = unknown, R = T, D = unknown>(options: lark.HttpRequestOptions<D>): Promise<R> =>
      base.request<T, R, D>(
        bound(String(options?.url ?? "")) ? { ...options, timeout: options?.timeout ?? REQUEST_TIMEOUT_MS } : options,
      ),
    post: <T = unknown, R = T, D = unknown>(url: string, data?: D, options?: lark.HttpRequestOptions<D>): Promise<R> =>
      base.post<T, R, D>(
        url,
        data,
        String(url).endsWith("/open-apis/auth/v3/tenant_access_token/internal")
          ? { ...options, timeout: options?.timeout ?? REQUEST_TIMEOUT_MS }
          : options,
      ),
  };
}

/**
 * A streaming card (CardKit) replying to a message: one markdown element whose content is
 * replaced on each push, in order. Unlike the SDK's `stream()`, a failed push does not end the
 * card: progress is best effort, the answer is what must land, and its push reports failure so
 * the caller can send it another way. Streaming mode is kept on past Feishu's ten minutes.
 */
async function openCard(client: LarkClient, replyTo: string, initial: string, replyInThread = false) {
  const created = await client.cardkit.v1.card.create({
    data: { type: "card_json", data: cardJson(initial) },
  });
  const cardId = ok(created).data?.card_id;
  if (!cardId) throw new Error("Feishu created no card");
  const sent = await client.im.v1.message.reply({
    path: { message_id: replyTo },
    data: {
      msg_type: "interactive",
      content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
      ...(replyInThread ? { reply_in_thread: true } : {}),
    },
  });
  const messageId = ok(sent).data?.message_id ?? "";
  // One sequence per card for every operation on it; Feishu rejects one that does not grow.
  let sequence = 0;
  let streamingSince = Date.now();
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => {});
    return run;
  };
  const settings = async (config: Record<string, unknown>) => {
    const seq = ++sequence;
    ok(
      await client.cardkit.v1.card.settings({
        path: { card_id: cardId },
        data: { settings: JSON.stringify({ config }), sequence: seq, uuid: `s_${cardId}_${seq}` },
      }),
    );
  };
  const reopen = async () => {
    await settings({ streaming_mode: true });
    streamingSince = Date.now();
  };
  const write = async (content: string) => {
    const seq = ++sequence;
    ok(
      await client.cardkit.v1.cardElement.content({
        path: { card_id: cardId, element_id: CARD_ELEMENT },
        data: { content, sequence: seq, uuid: `c_${cardId}_${seq}` },
      }),
    );
  };
  return {
    messageId,
    push: (content: string) =>
      serial(async () => {
        if (Date.now() - streamingSince > STREAM_RENEW_MS) await reopen().catch(() => {});
        try {
          await write(content);
        } catch (error) {
          if (!STREAM_CLOSED.has(feishuCode(error) ?? 0)) throw error;
          await reopen();
          await write(content);
        }
      }),
    /**
     * Replaces the whole card with the answer: one full update whose JSON has streaming off, so
     * it lands whether or not streaming is still open (the card entity is editable for 14 days).
     * Only on rejection does it close streaming as best effort and report failure.
     */
    finish: (content: string) =>
      serial(async () => {
        const flat = content
          .replace(/<at id=[^>]*><\/at>/g, "")
          .replace(/\s+/g, " ")
          .trim();
        const seq = ++sequence;
        try {
          ok(
            await client.cardkit.v1.card.update({
              path: { card_id: cardId },
              data: {
                card: { type: "card_json", data: cardJson(content, flat.length > 50 ? `${flat.slice(0, 49)}…` : flat) },
                sequence: seq,
                uuid: `u_${cardId}_${seq}`,
              },
            }),
          );
        } catch (error) {
          await settings({ streaming_mode: false }).catch(() => {});
          throw error;
        }
      }),
  };
}

/**
 * The card's JSON 2.0 document. Streaming config applies while progress is shown; the final
 * document (marked by a summary, even an empty one) turns streaming off and carries the summary
 * the chat list previews instead.
 */
function cardJson(content: string, summary?: string): string {
  return JSON.stringify({
    schema: "2.0",
    config:
      summary !== undefined
        ? { streaming_mode: false, summary: { content: summary || "…" } }
        : {
            streaming_mode: true,
            summary: { content: "..." },
            streaming_config: {
              print_frequency_ms: { default: 70 },
              print_step: { default: 1 },
              print_strategy: "fast",
            },
          },
    body: { elements: [{ tag: "markdown", element_id: CARD_ELEMENT, content }] },
  });
}

/** A raw client response: a non-zero Feishu code is an error. */
function ok<T extends { code?: number | undefined; msg?: string | undefined }>(response: T): T {
  if (response.code)
    throw Object.assign(new Error(response.msg ?? `Feishu error ${response.code}`), { code: response.code });
  return response;
}

/** The Feishu error code of a raw client failure: on the error, or in the HTTP response body. */
function feishuCode(error: unknown): number | undefined {
  const e = error as { code?: unknown; response?: { data?: { code?: unknown } } };
  const code = typeof e?.code === "number" ? e.code : e?.response?.data?.code;
  return typeof code === "number" ? code : undefined;
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
    async register({ signal, agentName, appId, scopes, onQRCodeReady }) {
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
          scopes: { tenant: [...scopes] },
          events: { items: { tenant: ["im.message.receive_v1", "im.chat.member.bot.added_v1", DOC_COMMENT_EVENT] } },
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
  const token = (await tokenResponse.json().catch(() => null)) as {
    code?: number;
    msg?: string;
    tenant_access_token?: string;
  } | null;
  if (token?.code !== 0 || !token.tenant_access_token) {
    throw new Error(`Feishu auth failed: ${token?.msg ?? token?.code ?? `HTTP ${tokenResponse.status}`}`);
  }
  const response = await fetch(`${origin}${path}`, {
    headers: { authorization: `Bearer ${token.tenant_access_token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => null)) as (T & { code?: number; msg?: string }) | null;
  if (body?.code !== 0) {
    throw new Error(`Feishu ${path} failed: ${body?.msg ?? body?.code ?? `HTTP ${response.status}`}`);
  }
  return body;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
