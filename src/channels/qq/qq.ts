import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { startQrConnect } from "@tencent-connect/qqbot-connector";
import { QQBot } from "@tencent-connect/qqbot-nodejs";
import type {
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
  OnboardingEvent,
  OutboundMessage,
  ReactionState,
  SendResult,
} from "../channel.ts";

/**
 * QQ bots through Tencent's official SDKs: QR binding with qqbot-connector, then the
 * WebSocket gateway with qqbot-nodejs. Direct chats and groups (when @-mentioned).
 * Live replies use QQ's stream_messages, which QQ only allows in direct chats and
 * within five minutes of the message being answered.
 */

const QR_TTL_MS = 5 * 60_000;
/** stream_messages must start from an inbound message less than five minutes old. */
const STREAM_WINDOW_MS = 4.5 * 60_000;

const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;

const CAPABILITIES: Capabilities = {
  quoteReply: false,
  reactions: false,
  typingIndicator: true,
  fileUpload: true,
  fileDownload: true,
  listMembers: false,
  // QQ rejects very long messages; the outbox splits above this.
  maxTextLength: 2000,
};

type ReplyTarget = { scope: "c2c" | "group"; targetId: string; msgId?: string };

export interface QqInbound {
  kind: "c2c" | "group" | "guild" | "dm";
  senderId: string;
  senderName?: string;
  senderIsBot?: boolean;
  content: string;
  messageId: string;
  timestamp: string;
  groupOpenid?: string;
  attachments?: { content_type: string; url: string; filename?: string; size?: number }[];
  replyTarget: ReplyTarget;
}

/** The parts of QQBot used here. Injected so tests run offline. */
export interface QqBotLike {
  on(event: "message", handler: (ctx: unknown, msg: QqInbound) => void): unknown;
  on(event: "ready" | "resumed" | "error", handler: (arg: unknown) => void): unknown;
  start(signal?: AbortSignal): Promise<void>;
  stop(): void;
  sendText(target: ReplyTarget, content: string): Promise<{ id?: string }>;
  sendTyping(target: ReplyTarget, seconds?: number): Promise<unknown>;
  sendImage(target: ReplyTarget, source: { localPath: string }): Promise<{ message?: { id?: string } }>;
  sendFile(
    target: ReplyTarget,
    source: { localPath: string },
    opts?: { fileName?: string },
  ): Promise<{ message?: { id?: string } }>;
  openStream(opts: { target: ReplyTarget; throttleMs?: number }): {
    update(fullText: string): Promise<void>;
    complete(): Promise<{ id?: string } | undefined>;
    cancel(): void;
  };
  api: { getToken(): Promise<string> };
}

type QrStart = typeof startQrConnect;

export interface QqOptions {
  readonly startQr?: QrStart;
  readonly createBot?: (credentials: { appId: string; appSecret: string }) => QqBotLike;
  readonly readyTimeoutMs?: number;
}

export function qqChannel(options: QqOptions = {}): Channel {
  const startQr = options.startQr ?? startQrConnect;
  const create =
    options.createBot ??
    ((c) =>
      new QQBot({
        appId: c.appId,
        appSecret: c.appSecret,
        // Markdown needs a permission QQ grants after review; plain text works for every bot.
        markdownSupport: false,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      }) as unknown as QqBotLike);

  return {
    platform: "qq",
    onboarding: { kind: "qr" },
    manualFields: [
      { key: "appId", labelKey: "qq.appId", secret: false },
      { key: "appSecret", labelKey: "qq.appSecret", secret: true },
    ],

    async *onboard(input, signal, context): AsyncIterable<OnboardingEvent> {
      const name = context?.agentName ?? "QQ bot";
      if (input?.appId && input.appSecret) {
        try {
          await create({ appId: input.appId, appSecret: input.appSecret }).api.getToken();
          yield {
            kind: "succeeded",
            credentials: { appId: input.appId, appSecret: input.appSecret, name },
            bot: { id: input.appId, name },
          };
        } catch {
          yield { kind: "failed", code: "invalid_credentials" };
        }
        return;
      }

      // The connector reports through callbacks; turn them into the event stream.
      const queue: OnboardingEvent[] = [];
      let wake: (() => void) | undefined;
      const push = (event: OnboardingEvent) => {
        queue.push(event);
        wake?.();
      };
      const dispose = startQr(
        {
          onQrDisplayed: (url) => push({ kind: "qr_ready", qrContent: url, expiresAt: Date.now() + QR_TTL_MS }),
          // The connector issues a fresh code by itself; the next onQrDisplayed carries it.
          onQrExpired: () => {},
          onSuccess: (credentials) => {
            const first = credentials[0];
            if (!first?.appId || !first.appSecret) {
              push({ kind: "failed", code: "unknown" });
              return;
            }
            push({
              kind: "succeeded",
              credentials: { appId: first.appId, appSecret: first.appSecret, name },
              bot: { id: first.appId, name },
              ...(first.userOpenid ? { ownerId: first.userOpenid } : {}),
            });
          },
          onFailure: () => push({ kind: "failed", code: signal.aborted ? "cancelled" : "network" }),
        },
        { displayQrCodeToConsole: false, source: "mingle", signal },
      );
      signal.addEventListener("abort", () => push({ kind: "failed", code: "cancelled" }), { once: true });
      try {
        for (;;) {
          while (queue.length > 0) {
            const event = queue.shift() as OnboardingEvent;
            yield event;
            if (event.kind === "succeeded" || event.kind === "failed") return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
      } finally {
        dispose();
      }
    },

    async connect(credentials: Credentials, events: ChannelEvents): Promise<ChannelConnection> {
      const appId = credentials.appId ?? "";
      const bot = create({ appId, appSecret: credentials.appSecret ?? "" });
      const stop = new AbortController();
      /** Reply targets of inbound messages: QQ answers passively by message ID. */
      const targets = new Map<string, { target: ReplyTarget; at: number }>();
      const files = new Map<string, string>();

      bot.on("message", (_ctx, msg) => {
        const inbound = toInbound(msg);
        if (!inbound) return;
        targets.set(inbound.platformId, { target: msg.replyTarget, at: Date.now() });
        if (targets.size > 2000) targets.delete(targets.keys().next().value as string);
        msg.attachments?.forEach((a, i) => {
          files.set(`${msg.messageId}:${i}`, a.url);
        });
        events.onMessage(inbound);
      });
      bot.on("error", () => events.onState({ kind: "reconnecting", attempt: 1 }));
      bot.on("resumed", () => events.onState({ kind: "connected" }));

      // start() fails fast when it cannot get a token, then keeps running until stopped.
      let started = false;
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          started = true;
          resolve();
        }, options.readyTimeoutMs ?? 10_000);
        bot.on("ready", () => {
          clearTimeout(timer);
          if (started) events.onState({ kind: "connected" });
          started = true;
          resolve();
        });
        bot
          .start(stop.signal)
          .then(() => {
            // The gateway gave up on its own (a fatal close): Mingle starts it over.
            if (!stop.signal.aborted) events.onState({ kind: "error", code: "unknown" });
          })
          .catch((error) => {
            clearTimeout(timer);
            if (stop.signal.aborted) return;
            const code = startFailure(error);
            if (started) events.onState({ kind: "error", code });
            else {
              // Only refused credentials are final; anything else (offline after sleep, a QQ
              // outage) passes, and Mingle tries again by itself.
              if (code === "credentials_revoked") events.onState({ kind: "error", code });
              reject(error);
            }
          });
      });
      await ready;

      const targetFor = (chat: ChatRef, replyTo?: string): ReplyTarget => {
        const known = replyTo ? targets.get(replyTo)?.target : undefined;
        return known ?? { scope: chat.kind === "dm" ? "c2c" : "group", targetId: chat.platformId };
      };

      return {
        bot: { id: appId, name: credentials.name ?? "QQ bot" },
        capabilities: () => CAPABILITIES,

        async send(message: OutboundMessage): Promise<SendResult> {
          const target = targetFor(message.chat, message.replyTo);
          try {
            let response: { id?: string } = {};
            if (message.text.trim()) {
              try {
                response = await bot.sendText(target, message.text);
              } catch (error) {
                // A passive reply window may have closed; try once as an active message.
                if (!target.msgId) throw error;
                const { msgId: _expired, ...active } = target;
                response = await bot.sendText(active, message.text);
              }
            }
            let dropped = false;
            for (const file of message.files ?? []) {
              const name = file.name ?? basename(file.path);
              try {
                const sent = IMAGE.test(name)
                  ? await bot.sendImage(target, { localPath: file.path })
                  : await bot.sendFile(target, { localPath: file.path }, { fileName: name });
                response = sent.message?.id ? { id: sent.message.id } : response;
              } catch {
                // Generic files need a permission many bots lack; the text still went out.
                dropped = true;
              }
            }
            return {
              kind: "sent",
              platformId: response.id ?? `out-${Date.now()}`,
              degraded: ["markdown_flattened", ...(dropped ? (["files_dropped"] as const) : [])],
            };
          } catch (error) {
            const status = (error as { status?: number; httpStatus?: number }).status ?? 0;
            return status === 429
              ? { kind: "failed", code: "rate_limited", retryable: true }
              : { kind: "failed", code: "unknown", retryable: false };
          }
        },

        /** QQ has no reactions for bots; in direct chats "typing…" shows the agent is on it. */
        async react(chat: ChatRef, platformMessageId: string, state: ReactionState) {
          if (state !== "processing" || chat.kind !== "dm") return;
          await bot.sendTyping(targetFor(chat, platformMessageId), 60).catch(() => {});
        },

        async startLive(chat: ChatRef, live: LiveOptions): Promise<LiveReply> {
          const known = targets.get(live.replyTo);
          if (chat.kind !== "dm" || !known) throw new Error("QQ streams only in direct chats");
          const stream = bot.openStream({ target: known.target, throttleMs: 500 });
          await stream.update(plain(live.initial));
          return {
            update: async (markdown) => {
              await stream.update(plain(markdown)).catch(() => {});
            },
            finish: async (markdown) => {
              if (Date.now() - known.at > STREAM_WINDOW_MS) {
                stream.cancel();
                return { kind: "failed", code: "unknown", retryable: false };
              }
              try {
                await stream.update(plain(markdown));
                const done = await stream.complete();
                return { kind: "sent", platformId: done?.id ?? `stream-${live.replyTo}` };
              } catch {
                return { kind: "failed", code: "unknown", retryable: false };
              }
            },
          };
        },

        async setTyping(chat: ChatRef, on: boolean) {
          if (on && chat.kind === "dm") await bot.sendTyping(targetFor(chat), 60).catch(() => {});
        },

        async download(attachment: InboundAttachment, toPath: string) {
          const url = files.get(attachment.id);
          if (!url) throw new Error("this file is no longer available; ask for it to be sent again");
          const response = await fetch(url.startsWith("//") ? `https:${url}` : url, {
            signal: AbortSignal.timeout(120_000),
          });
          if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
          await writeFile(toPath, Buffer.from(await response.arrayBuffer()));
        },

        async listMembers() {
          return [];
        },

        async close() {
          stop.abort();
          bot.stop();
        },
      };
    },
  };
}

/** Progress text uses **bold**; QQ shows plain text. */
function plain(markdown: string): string {
  return markdown.replace(/\*\*(.+?)\*\*/g, "$1").replace(/(^|\s)\*(\S.*?)\*(?=\s|$)/g, "$1$2");
}

/** Map a QQ message to Mingle's shape. Exported for tests. */
export function toInbound(msg: QqInbound): InboundMessage | undefined {
  if (msg.kind !== "c2c" && msg.kind !== "group") return undefined; // Guild channels are out of scope.
  if (msg.senderIsBot || !msg.messageId || !msg.senderId) return undefined;
  const group = msg.kind === "group" && msg.groupOpenid;
  const attachments: InboundAttachment[] = (msg.attachments ?? []).map((a, i) => ({
    id: `${msg.messageId}:${i}`,
    name: a.filename ?? `${a.content_type.startsWith("image") ? "image" : "file"}-${i + 1}`,
    ...(a.size !== undefined ? { size: a.size } : {}),
    mime: a.content_type,
  }));
  return {
    platformId: msg.messageId,
    chat: group ? { platformId: msg.groupOpenid as string, kind: "group" } : { platformId: msg.senderId, kind: "dm" },
    sender: { id: msg.senderId, name: msg.senderName ?? "", isBot: false },
    // QQ leaves the bot's mention out of group content; trim the space it leaves.
    text: msg.content.trim(),
    attachments,
    // QQ only delivers group messages that @ the bot.
    addressedToBot: true,
    sentAt: Number.isNaN(Date.parse(msg.timestamp)) ? Date.now() : Date.parse(msg.timestamp),
  };
}

/**
 * Why qqbot-nodejs could not start. Its token fetch throws "Network error getting
 * access_token" when QQ cannot be reached and "Token fetch failed: HTTP <status>" when it
 * answered with an error; only a 4xx or a token-less answer means the App ID or secret is wrong.
 */
export function startFailure(error: unknown): "credentials_revoked" | "network" {
  const message = error instanceof Error ? error.message : String(error);
  if (/^Token fetch failed: HTTP 4\d\d/.test(message) || /^Failed to get access_token/.test(message)) {
    return "credentials_revoked";
  }
  return "network";
}
