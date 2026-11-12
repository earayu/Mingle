import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import * as lark from "@larksuiteoapi/node-sdk";
import type {
  BotIdentity,
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

/**
 * Feishu (and Lark) through the official SDK: QR app registration, then a
 * long connection for events. No public callback address is needed.
 */

/** Tenant scopes requested when the app is created. Group messages that do not @ the bot are not requested (docs/spec.md 13). */
export const FEISHU_SCOPES = [
  "im:message.p2p_msg:readonly",
  "im:message.group_at_msg:readonly",
  "im:message:readonly",
  "im:message:send_as_bot",
  "im:message.reactions:write_only",
  "im:resource",
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
  listMembers: false,
  maxTextLength: 8000,
};

/** Streaming cards stop taking updates after about ten minutes; stay under it. */
const STREAM_LIMIT_MS = 9 * 60_000;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

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
    onQRCodeReady: (info: { url: string; expireIn: number }) => void;
  }): Promise<{ appId: string; appSecret: string; ownerId?: string; domain: Domain }>;
  botInfo(credentials: { appId: string; appSecret: string; domain: Domain }): Promise<BotInfo>;
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
    onboarding: { kind: "qr", desktopLink: true },
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

      const start = async () => {
        const instance = create({
          appId: credentials.appId,
          appSecret: credentials.appSecret,
          domain: credentials.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
          transport: "websocket",
          loggerLevel: lark.LoggerLevel.warn,
          source: "mingle",
          // Mingle does its own batching and access rules.
          policy: { dmMode: "open", requireMention: true, respondToMentionAll: false },
          safety: { batch: { text: { delayMs: 0 }, media: { delayMs: 0 } } },
        });
        channel = instance;
        instance.on("message", async (message) => {
          const senderName = message.senderName ?? (await userName(message.senderId));
          const inbound = toInbound(
            senderName ? { ...message, senderName } : message,
            bot,
            message.chatType === "group" ? await chatName(message.chatId) : undefined,
          );
          if (inbound) events.onMessage(inbound);
        });
        instance.on("botAdded", async (event) => {
          const name = await chatName(event.chatId);
          events.onMembership({
            chat: { platformId: event.chatId, kind: "group", ...(name ? { name } : {}) },
            joined: true,
          });
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

      return {
        bot,
        capabilities: () => CAPABILITIES,

        async send(message: OutboundMessage): Promise<SendResult> {
          if (!channel) return { kind: "failed", code: "forbidden", retryable: false };
          const opts = message.replyTo ? { replyTo: message.replyTo } : {};
          try {
            let last = "";
            if (message.text)
              last = (await channel.send(message.chat.platformId, { markdown: message.text }, opts)).messageId;
            for (const file of message.files ?? []) {
              const source = await readFile(file.path);
              const name = file.name ?? basename(file.path);
              const input = IMAGE_EXTENSIONS.has(extname(name).toLowerCase())
                ? { image: { source } }
                : { file: { source, fileName: name } };
              last = (await channel.send(message.chat.platformId, input, opts)).messageId;
            }
            return { kind: "sent", platformId: last };
          } catch (error) {
            return sendFailure(error);
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

        async listMembers() {
          return [];
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

function domainOf(credentials: Credentials): Domain {
  return credentials.domain === "lark" ? "lark" : "feishu";
}

/** Map a normalized Feishu message to Mingle's shape. Exported for tests. */
export function toInbound(
  message: lark.NormalizedMessage,
  bot: BotIdentity,
  chatName: string | undefined,
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
    sender: { id: message.senderId, name: message.senderName ?? "", isBot: false },
    text,
    attachments,
    ...(message.replyToMessageId ? { replyTo: message.replyToMessageId } : {}),
    addressedToBot: dm || message.mentionedBot,
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
    async register({ signal, agentName, onQRCodeReady }) {
      const result = await lark.registerApp({
        source: "mingle",
        signal,
        createOnly: true,
        appPreset: {
          name: agentName ? `${agentName}` : "Mingle Agent",
          desc: "An agent that lives in your chats, run by Mingle on its owner's computer.",
        },
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

    async botInfo({ appId, appSecret, domain }) {
      const origin = domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
      const tokenResponse = await fetch(`${origin}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: AbortSignal.timeout(15_000),
      });
      const token = (await tokenResponse.json()) as { code: number; msg?: string; tenant_access_token?: string };
      if (token.code !== 0 || !token.tenant_access_token)
        throw new Error(`Feishu auth failed: ${token.msg ?? token.code}`);
      const botResponse = await fetch(`${origin}/open-apis/bot/v3/info/`, {
        headers: { authorization: `Bearer ${token.tenant_access_token}` },
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await botResponse.json()) as {
        code: number;
        msg?: string;
        bot?: { app_name?: string; open_id?: string; activate_status?: number };
      };
      if (body.code !== 0) throw new Error(`Feishu bot info failed: ${body.msg ?? body.code}`);
      return {
        name: body.bot?.app_name ?? "Feishu bot",
        openId: body.bot?.open_id ?? appId,
        activated: body.bot?.activate_status === ACTIVE,
      };
    },
  };
}
