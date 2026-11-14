import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
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
  OnboardingEvent,
  OutboundMessage,
  ReactionState,
  SendResult,
} from "../channel.ts";
import { withTextSent } from "../channel.ts";

/** Telegram Bot API, long polling. No webhook, so no public address is needed. */

type Fetch = typeof fetch;

interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}
interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  first_name?: string;
  last_name?: string;
  is_forum?: boolean;
}
interface TgEntity {
  type: string;
  offset: number;
  length: number;
  user?: TgUser;
}
interface TgFile {
  file_id: string;
  file_name?: string;
  file_size?: number;
  mime_type?: string;
}
export interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: TgEntity[];
  caption_entities?: TgEntity[];
  reply_to_message?: TgMessage;
  document?: TgFile;
  photo?: (TgFile & { width: number })[];
  audio?: TgFile;
  voice?: TgFile;
  video?: TgFile;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  my_chat_member?: { chat: TgChat; new_chat_member: { status: string } };
}

class TgError extends Error {
  readonly status: number;
  readonly description: string;
  readonly retryAfter: number | undefined;
  constructor(status: number, description: string, retryAfter?: number) {
    super(`Telegram ${status}: ${description}`);
    this.status = status;
    this.description = description;
    this.retryAfter = retryAfter;
  }
}

const CAPABILITIES: Capabilities = {
  quoteReply: true,
  reactions: true,
  typingIndicator: true,
  fileUpload: true,
  fileDownload: true,
  listMembers: false,
  maxTextLength: 4096,
};

export interface TelegramOptions {
  readonly fetch?: Fetch;
  readonly apiBase?: string;
  /** Long-poll timeout in seconds. */
  readonly pollTimeout?: number;
}

export function telegramChannel(options: TelegramOptions = {}): Channel {
  const fetchImpl = options.fetch ?? fetch;
  const apiBase = options.apiBase ?? "https://api.telegram.org";
  const pollTimeout = options.pollTimeout ?? 30;

  function client(token: string) {
    async function call<T>(method: string, body?: unknown, signal?: AbortSignal, timeoutMs = 20_000): Promise<T> {
      const timeout = AbortSignal.timeout(timeoutMs);
      const init: RequestInit = {
        method: "POST",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      };
      if (body instanceof FormData) init.body = body;
      else if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers = { "content-type": "application/json" };
      }
      const response = await fetchImpl(`${apiBase}/bot${token}/${method}`, init);
      const json = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        result?: T;
        description?: string;
        parameters?: { retry_after?: number };
      };
      if (!json.ok) {
        throw new TgError(response.status, json.description ?? response.statusText, json.parameters?.retry_after);
      }
      return json.result as T;
    }
    return { call };
  }

  return {
    platform: "telegram",
    onboarding: {
      kind: "credentials",
      setupUrl: "https://t.me/BotFather",
      fields: [{ key: "token", labelKey: "telegram.token", secret: true }],
    },

    async *onboard(input: Credentials | undefined): AsyncIterable<OnboardingEvent> {
      const token = input?.token?.trim();
      if (!token || !/^\d+:[\w-]{20,}$/.test(token)) {
        yield { kind: "failed", code: "invalid_credentials" };
        return;
      }
      try {
        const me = await client(token).call<TgUser>("getMe");
        yield { kind: "succeeded", credentials: { token }, bot: identity(me) };
      } catch (error) {
        yield {
          kind: "failed",
          code: error instanceof TgError && error.status === 401 ? "invalid_credentials" : "network",
        };
      }
    },

    async connect(credentials: Credentials, events: ChannelEvents): Promise<ChannelConnection> {
      const token = credentials.token ?? "";
      const api = client(token);
      const me = await api.call<TgUser>("getMe");
      const bot = identity(me);
      const stop = new AbortController();
      let offset = 0;

      const poll = async () => {
        let failures = 0;
        while (!stop.signal.aborted) {
          try {
            const updates = await api.call<TgUpdate[]>(
              "getUpdates",
              { offset, timeout: pollTimeout, allowed_updates: ["message", "my_chat_member"] },
              stop.signal,
              (pollTimeout + 10) * 1000,
            );
            if (failures > 0) events.onState({ kind: "connected" });
            failures = 0;
            for (const update of updates) {
              offset = update.update_id + 1;
              if (update.message) {
                const inbound = toInbound(update.message, me);
                if (inbound) events.onMessage(inbound);
              } else if (update.my_chat_member) {
                const status = update.my_chat_member.new_chat_member.status;
                events.onMembership({
                  chat: chatRef(update.my_chat_member.chat),
                  joined: status === "member" || status === "administrator",
                });
              }
            }
          } catch (error) {
            if (stop.signal.aborted) return;
            if (error instanceof TgError && error.status === 401) {
              events.onState({ kind: "error", code: "credentials_revoked" });
              return;
            }
            if (error instanceof TgError && error.status === 409) {
              // Another process is polling with the same token.
              events.onState({ kind: "error", code: "unknown" });
              return;
            }
            failures++;
            events.onState({ kind: "reconnecting", attempt: failures });
            const wait =
              error instanceof TgError && error.retryAfter
                ? error.retryAfter * 1000
                : Math.min(30_000, 1000 * 2 ** failures);
            await sleep(wait, stop.signal);
          }
        }
      };
      void poll();

      const setTyping = async (chat: ChatRef, typing: boolean) => {
        if (!typing) return;
        const { chatId, threadId } = parseChat(chat.platformId);
        await api
          .call("sendChatAction", {
            chat_id: chatId,
            action: "typing",
            ...(threadId ? { message_thread_id: threadId } : {}),
          })
          .catch(() => {});
      };

      return {
        bot,
        capabilities: () => CAPABILITIES,

        async send(message: OutboundMessage): Promise<SendResult> {
          const { chatId, threadId } = parseChat(message.chat.platformId);
          const base = {
            chat_id: chatId,
            ...(threadId ? { message_thread_id: threadId } : {}),
            ...(message.replyTo
              ? { reply_parameters: { message_id: Number(message.replyTo), allow_sending_without_reply: true } }
              : {}),
          };
          let textId = "";
          try {
            let lastId = "";
            if (message.text) {
              const sent = await api.call<TgMessage>("sendMessage", { ...base, text: message.text });
              lastId = textId = String(sent.message_id);
            }
            for (const file of message.files ?? []) {
              const form = new FormData();
              for (const [k, v] of Object.entries(base))
                form.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
              form.set("document", new Blob([await readFile(file.path)]), file.name ?? basename(file.path));
              const sent = await api.call<TgMessage>("sendDocument", form, undefined, 120_000);
              lastId = String(sent.message_id);
            }
            // Plain text: Telegram's Markdown dialects reject common Markdown, so formatting is not interpreted.
            return { kind: "sent", platformId: lastId, degraded: ["markdown_flattened"] };
          } catch (error) {
            return withTextSent(sendFailure(error), textId);
          }
        },

        async react(chat: ChatRef, platformMessageId: string, state: ReactionState) {
          const { chatId } = parseChat(chat.platformId);
          // 👀 while working; cleared once answered (the answer speaks for itself); 👎 on failure.
          const emoji = { processing: "👀", done: null, error: "👎", none: null }[state];
          await api
            .call("setMessageReaction", {
              chat_id: chatId,
              message_id: Number(platformMessageId),
              reaction: emoji ? [{ type: "emoji", emoji }] : [],
            })
            .catch(() => (state === "processing" ? setTyping(chat, true) : undefined));
        },

        /** A placeholder message, edited as progress comes in and finally replaced by the answer. */
        async startLive(chat: ChatRef, options: LiveOptions): Promise<LiveReply> {
          const { chatId, threadId } = parseChat(chat.platformId);
          const placeholder = await api.call<TgMessage>("sendMessage", {
            chat_id: chatId,
            ...(threadId ? { message_thread_id: threadId } : {}),
            reply_parameters: { message_id: Number(options.replyTo), allow_sending_without_reply: true },
            text: plain(options.initial),
          });
          const edit = (text: string) =>
            api.call("editMessageText", { chat_id: chatId, message_id: placeholder.message_id, text });
          let last = plain(options.initial);
          return {
            update: async (markdown) => {
              const text = plain(markdown);
              if (text === last) return;
              last = text;
              await edit(text).catch(() => {});
            },
            finish: async (markdown) => {
              try {
                await edit(plain(markdown));
                return { kind: "sent", platformId: String(placeholder.message_id), degraded: ["markdown_flattened"] };
              } catch (error) {
                return sendFailure(error);
              }
            },
          };
        },

        setTyping,

        async download(attachment: InboundAttachment, toPath: string) {
          const file = await api.call<{ file_path?: string }>("getFile", { file_id: attachment.id });
          if (!file.file_path)
            throw new Error("Telegram did not return a download path (files over 20 MB cannot be fetched by bots)");
          const response = await fetchImpl(`${apiBase}/file/bot${token}/${file.file_path}`, {
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
        },
      };
    },
  };
}

/** Mingle's progress text uses **bold** and *italic*; Telegram gets it as plain text. */
function plain(markdown: string): string {
  return markdown.replace(/\*\*(.+?)\*\*/g, "$1").replace(/(^|\s)\*(\S.*?)\*(?=\s|$)/g, "$1$2");
}

function identity(user: TgUser): BotIdentity {
  return { id: String(user.id), name: user.username ? `@${user.username}` : user.first_name };
}

function displayName(user: TgUser): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || String(user.id);
}

function chatRef(chat: TgChat, threadId?: number): ChatRef {
  const kind = chat.type === "private" ? "dm" : threadId ? "thread" : "group";
  const name =
    chat.type === "private" ? [chat.first_name, chat.last_name].filter(Boolean).join(" ") : (chat.title ?? undefined);
  return {
    platformId: threadId ? `${chat.id}:${threadId}` : String(chat.id),
    kind,
    ...(name ? { name } : {}),
  };
}

function parseChat(platformId: string): { chatId: number; threadId?: number } {
  const [chat, thread] = platformId.split(":");
  return thread ? { chatId: Number(chat), threadId: Number(thread) } : { chatId: Number(chat) };
}

/** Map a Telegram message to Mingle's inbound shape. Exported for tests. */
export function toInbound(message: TgMessage, me: TgUser): InboundMessage | undefined {
  if (!message.from || message.chat.type === "channel") return undefined;
  const raw = message.text ?? message.caption ?? "";
  const entities = message.entities ?? message.caption_entities ?? [];
  const username = me.username?.toLowerCase();

  let mentioned = false;
  let text = raw;
  // Remove mentions of this bot, back to front so offsets stay valid.
  for (const e of [...entities].sort((a, b) => b.offset - a.offset)) {
    const slice = raw.slice(e.offset, e.offset + e.length);
    const isMe =
      (e.type === "mention" && slice.toLowerCase() === `@${username}`) ||
      (e.type === "text_mention" && e.user?.id === me.id);
    if (isMe) {
      mentioned = true;
      text = text.slice(0, e.offset) + text.slice(e.offset + e.length);
    }
  }
  // "/stop@MyBot" addresses this bot too; normalise to "/stop".
  if (username) {
    const command = new RegExp(`^(/\\w+)@${username}\\b`, "i");
    if (command.test(text.trim())) {
      mentioned = true;
      text = text.trim().replace(command, "$1");
    }
  }
  text = text.replace(/[ \t]{2,}/g, " ").trim();

  const repliedToMe = message.reply_to_message?.from?.id === me.id;
  // In forum groups every message carries a thread id; the "General" topic has none.
  const threadId = message.is_topic_message ? message.message_thread_id : undefined;
  const chat = chatRef(message.chat, threadId);

  const attachments: InboundAttachment[] = [];
  const add = (file: TgFile | undefined, fallbackName: string) => {
    if (!file) return;
    attachments.push({
      id: file.file_id,
      name: file.file_name ?? fallbackName,
      ...(file.file_size !== undefined ? { size: file.file_size } : {}),
      ...(file.mime_type ? { mime: file.mime_type } : {}),
    });
  };
  add(message.document, "document");
  const photo = message.photo?.reduce((a, b) => (b.width > a.width ? b : a));
  add(photo && { ...photo, mime_type: "image/jpeg" }, `photo-${message.message_id}.jpg`);
  add(message.audio, `audio-${message.message_id}`);
  add(message.voice, `voice-${message.message_id}.ogg`);
  add(message.video, `video-${message.message_id}.mp4`);

  return {
    platformId: String(message.message_id),
    chat,
    sender: { id: String(message.from.id), name: displayName(message.from), isBot: message.from.is_bot },
    text,
    attachments,
    ...(message.reply_to_message && !isTopicRoot(message)
      ? { replyTo: String(message.reply_to_message.message_id) }
      : {}),
    addressedToBot: chat.kind === "dm" || mentioned || repliedToMe,
    sentAt: message.date * 1000,
  };
}

/** In forum topics, Telegram sets reply_to_message to the topic's creation message. That is not a real reply. */
function isTopicRoot(message: TgMessage): boolean {
  return Boolean(message.is_topic_message && message.reply_to_message?.message_id === message.message_thread_id);
}

function sendFailure(error: unknown): SendResult {
  if (error instanceof TgError) {
    if (error.status === 429) return { kind: "failed", code: "rate_limited", retryable: true };
    if (error.status === 403) return { kind: "failed", code: "forbidden", retryable: false };
    if (error.status === 413) return { kind: "failed", code: "too_large", retryable: false };
    if (error.status === 400 && /chat not found/i.test(error.description)) {
      return { kind: "failed", code: "chat_gone", retryable: false };
    }
    if (error.status >= 500) return { kind: "failed", code: "unknown", retryable: true };
    return { kind: "failed", code: "unknown", retryable: false };
  }
  // The request may have reached Telegram before the timeout fired: do not resend.
  if ((error as Error)?.name === "TimeoutError" || (error as Error)?.name === "AbortError")
    return { kind: "uncertain" };
  return { kind: "failed", code: "network", retryable: true };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
