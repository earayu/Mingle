import { readFile, stat, writeFile } from "node:fs/promises";
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

/**
 * Slack through Socket Mode: the app opens a WebSocket to Slack, so no public address is
 * needed. Plain Web API calls over fetch; no SDK.
 *
 * Chats: a DM is `D…`; a channel mention starts a thread, and everything in that thread is
 * one chat `C…:<thread ts>`. Replies render as Slack `markdown` blocks (standard Markdown).
 */

type Fetch = typeof fetch;
type Call = <T extends Record<string, unknown>>(
  method: string,
  body?: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<T>;

/** The part of the WebSocket API used here. Node's global WebSocket fits; tests inject a fake. */
export interface SocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface SlackOptions {
  readonly fetch?: Fetch;
  readonly createSocket?: (url: string) => SocketLike;
  readonly apiBase?: string;
}

const CAPABILITIES: Capabilities = {
  quoteReply: true,
  reactions: true,
  typingIndicator: false,
  fileUpload: true,
  fileDownload: true,
  listMembers: false,
  // A markdown block holds 12,000 characters.
  maxTextLength: 11_000,
};

/** Placeholders the console swaps for the agent's name, and for a handle made from it, in the manifest link. */
export const AGENT_NAME_PLACEHOLDER = "__MINGLE_AGENT_NAME__";
/** The bot user's display name only allows a-z, 0-9, "-", "_" and ".". */
export const AGENT_HANDLE_PLACEHOLDER = "__MINGLE_AGENT_HANDLE__";

const MANIFEST = {
  display_information: {
    name: AGENT_NAME_PLACEHOLDER,
    description: "An agent companion, run by Mingle on its owner's computer.",
  },
  features: {
    app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    bot_user: { display_name: AGENT_HANDLE_PLACEHOLDER, always_online: true },
  },
  oauth_config: {
    scopes: {
      bot: [
        "channels:history",
        "groups:history",
        "im:history",
        "chat:write",
        "reactions:write",
        "files:read",
        "files:write",
        "users:read",
      ],
    },
  },
  settings: {
    event_subscriptions: { bot_events: ["message.im", "message.channels", "message.groups"] },
    socket_mode_enabled: true,
    org_deploy_enabled: false,
    token_rotation_enabled: false,
  },
};

export const SLACK_SETUP_URL = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(MANIFEST))}`;

class SlackError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfter: number | undefined;
  constructor(code: string, status: number, retryAfter?: number) {
    super(`Slack: ${code}`);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const REVOKED = new Set(["invalid_auth", "token_revoked", "account_inactive", "not_authed", "token_expired"]);

interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  size?: number;
  mimetype?: string;
  url_private_download?: string;
  url_private?: string;
}

export interface SlackEvent {
  type: string;
  subtype?: string;
  channel: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  parent_user_id?: string;
  files?: SlackFile[];
}

export function slackChannel(options: SlackOptions = {}): Channel {
  const fetchImpl = options.fetch ?? fetch;
  const apiBase = options.apiBase ?? "https://slack.com/api";
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);

  function client(token: string) {
    const call: Call = async <T extends Record<string, unknown>>(
      method: string,
      body: Record<string, unknown> = {},
      timeoutMs = 20_000,
    ): Promise<T> => {
      const response = await fetchImpl(`${apiBase}/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json = (await response.json().catch(() => ({ ok: false, error: `http_${response.status}` }))) as {
        ok?: boolean;
        error?: string;
      } & T;
      if (!json.ok) {
        const retry = Number(response.headers.get("retry-after")) || undefined;
        throw new SlackError(json.error ?? "unknown", response.status, retry);
      }
      return json;
    };
    return call;
  }

  async function verify(botToken: string, appToken: string) {
    const auth = await client(botToken)<{ user_id: string; user: string; bot_id: string }>("auth.test");
    await client(appToken)("apps.connections.open");
    return auth;
  }

  return {
    platform: "slack",
    onboarding: {
      kind: "credentials",
      setupUrl: SLACK_SETUP_URL,
      fields: [
        { key: "botToken", labelKey: "slack.botToken", secret: true },
        { key: "appToken", labelKey: "slack.appToken", secret: true },
      ],
    },

    async *onboard(input: Credentials | undefined): AsyncIterable<OnboardingEvent> {
      const botToken = input?.botToken?.trim() ?? "";
      const appToken = input?.appToken?.trim() ?? "";
      if (!botToken.startsWith("xoxb-") || !appToken.startsWith("xapp-")) {
        yield { kind: "failed", code: "invalid_credentials" };
        return;
      }
      try {
        const auth = await verify(botToken, appToken);
        const name = await displayNameOf(client(botToken), auth.user_id).catch(() => auth.user);
        yield { kind: "succeeded", credentials: { botToken, appToken, name }, bot: { id: auth.user_id, name } };
      } catch (error) {
        const code = error instanceof SlackError && error.code !== "unknown" ? "invalid_credentials" : "network";
        yield { kind: "failed", code };
      }
    },

    async connect(credentials: Credentials, events: ChannelEvents): Promise<ChannelConnection> {
      const botToken = credentials.botToken ?? "";
      const call = client(botToken);
      const appCall = client(credentials.appToken ?? "");
      const auth = await call<{ user_id: string; user: string; bot_id: string }>("auth.test");
      const bot: BotIdentity = { id: auth.user_id, name: credentials.name ?? auth.user };
      const names = new Map<string, string>();
      const nameOf = async (userId: string) => {
        const known = names.get(userId);
        if (known !== undefined) return known;
        const name = await displayNameOf(call, userId).catch(() => "");
        names.set(userId, name);
        return name;
      };
      /** Inbound files by ID, for download. */
      const files = new Map<string, SlackFile>();
      /** Threads this bot has spoken in: replies there reach it without an @. */
      const threads = new Set<string>();
      const seen = new Set<string>();

      let socket: SocketLike | undefined;
      let closed = false;
      let attempt = 0;

      const handle = async (event: SlackEvent) => {
        const inbound = await toInbound(event, auth.user_id, nameOf, threads);
        if (!inbound) return;
        for (const f of event.files ?? []) files.set(f.id, f);
        events.onMessage(inbound);
      };

      const open = async (): Promise<void> => {
        if (closed) return;
        let url: string;
        try {
          ({ url } = await appCall<{ url: string }>("apps.connections.open"));
        } catch (error) {
          if (error instanceof SlackError && REVOKED.has(error.code)) {
            events.onState({ kind: "error", code: "credentials_revoked" });
            return;
          }
          attempt++;
          events.onState({ kind: "reconnecting", attempt });
          setTimeout(open, Math.min(30_000, 1000 * 2 ** attempt));
          return;
        }
        const ws = createSocket(url);
        socket = ws;
        ws.onmessage = (message) => {
          let envelope: {
            type: string;
            envelope_id?: string;
            payload?: { event?: SlackEvent; event_id?: string };
          };
          try {
            envelope = JSON.parse(String(message.data));
          } catch {
            return;
          }
          if (envelope.envelope_id) ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
          if (envelope.type === "hello") {
            if (attempt > 0) events.onState({ kind: "connected" });
            attempt = 0;
          } else if (envelope.type === "disconnect") {
            // Slack rotates sockets every few hours; open the next one before this closes.
            ws.onclose = null;
            ws.close();
            void open();
          } else if (envelope.type === "events_api" && envelope.payload?.event) {
            const id = envelope.payload.event_id ?? `${envelope.payload.event.channel}:${envelope.payload.event.ts}`;
            if (seen.has(id)) return; // Slack retries unacknowledged events.
            seen.add(id);
            if (seen.size > 5000) seen.delete(seen.values().next().value as string);
            void handle(envelope.payload.event).catch(() => {});
          }
        };
        ws.onclose = () => {
          if (closed || socket !== ws) return;
          attempt++;
          events.onState({ kind: "reconnecting", attempt });
          setTimeout(open, Math.min(30_000, 1000 * 2 ** attempt));
        };
        ws.onerror = () => {};
      };
      await open();

      const post = async (chat: ChatRef, text: string, replyTo?: string) => {
        const { channel, thread } = parseChat(chat.platformId);
        const threadTs = thread ?? (chat.kind === "group" ? replyTo : undefined);
        const sent = await call<{ ts: string }>("chat.postMessage", {
          channel,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          ...content(text),
        });
        if (threadTs) threads.add(`${channel}:${threadTs}`);
        return sent.ts;
      };

      return {
        bot,
        capabilities: () => CAPABILITIES,

        async send(message: OutboundMessage): Promise<SendResult> {
          const { channel, thread } = parseChat(message.chat.platformId);
          const threadTs = thread ?? (message.chat.kind === "group" ? message.replyTo : undefined);
          try {
            let ts = "";
            if (message.text.trim()) ts = await post(message.chat, message.text, message.replyTo);
            for (const file of message.files ?? []) {
              await upload(call, fetchImpl, file, channel, threadTs);
            }
            return { kind: "sent", platformId: ts || `file-${Date.now()}` };
          } catch (error) {
            return sendFailure(error);
          }
        },

        async react(chat: ChatRef, platformMessageId: string, state: ReactionState) {
          const { channel } = parseChat(chat.platformId);
          const set = (method: "reactions.add" | "reactions.remove", name: string) =>
            call(method, { channel, timestamp: platformMessageId, name }).catch(() => {});
          if (state === "processing") return void (await set("reactions.add", "eyes"));
          await set("reactions.remove", "eyes");
          if (state === "done") await set("reactions.add", "white_check_mark");
          if (state === "error") await set("reactions.add", "x");
        },

        /** A placeholder reply, edited as progress comes in and finally replaced by the answer. */
        async startLive(chat: ChatRef, live: LiveOptions): Promise<LiveReply> {
          const { channel } = parseChat(chat.platformId);
          const ts = await post(chat, live.initial, live.replyTo);
          let last = live.initial;
          const edit = (markdown: string) => call("chat.update", { channel, ts, ...content(markdown) });
          return {
            update: async (markdown) => {
              if (markdown === last) return;
              last = markdown;
              await edit(markdown).catch(() => {});
            },
            finish: async (markdown) => {
              try {
                await edit(live.mention ? `<@${live.mention}> ${markdown}` : markdown);
                return { kind: "sent", platformId: ts };
              } catch (error) {
                return sendFailure(error);
              }
            },
          };
        },

        // Slack has no typing indicator for bots outside its assistant surface; the 👀 reaction says it.
        async setTyping() {},

        async download(attachment: InboundAttachment, toPath: string) {
          const file = files.get(attachment.id);
          const url = file?.url_private_download ?? file?.url_private;
          if (!url) throw new Error("this file is no longer available; ask for it to be sent again");
          const response = await fetchImpl(url, {
            headers: { authorization: `Bearer ${botToken}` },
            signal: AbortSignal.timeout(120_000),
          });
          if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
          await writeFile(toPath, Buffer.from(await response.arrayBuffer()));
        },

        async messageUser(userId: string, text: string) {
          const { channel } = await call<{ channel: { id: string } }>("conversations.open", { users: userId });
          await call("chat.postMessage", { channel: channel.id, ...content(text) });
        },

        async listMembers() {
          return [];
        },

        async close() {
          closed = true;
          socket?.close();
        },
      };
    },
  };
}

/** Markdown block for the content, plain text for notifications and old clients. */
function content(markdown: string) {
  return { text: markdown.slice(0, 3000), blocks: [{ type: "markdown", text: markdown }] };
}

async function displayNameOf(call: Call, userId: string): Promise<string> {
  const { user } = await call<{
    user: { name: string; real_name?: string; profile?: { display_name?: string; real_name?: string } };
  }>("users.info", { user: userId });
  return user.profile?.display_name || user.profile?.real_name || user.real_name || user.name;
}

/** Slack's external upload: reserve a URL, send the bytes, then share the file into the chat. */
async function upload(
  call: Call,
  fetchImpl: Fetch,
  file: { path: string; name?: string },
  channel: string,
  threadTs: string | undefined,
) {
  const name = file.name ?? basename(file.path);
  const { size } = await stat(file.path);
  const reserved = await call<{ upload_url: string; file_id: string }>("files.getUploadURLExternal", {
    filename: name,
    length: size,
  });
  const sent = await fetchImpl(reserved.upload_url, {
    method: "POST",
    body: new Blob([await readFile(file.path)]),
    signal: AbortSignal.timeout(120_000),
  });
  if (!sent.ok) throw new SlackError(`upload_http_${sent.status}`, sent.status);
  await call("files.completeUploadExternal", {
    files: [{ id: reserved.file_id, title: name }],
    channel_id: channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
}

function parseChat(platformId: string): { channel: string; thread?: string } {
  const [channel = "", thread] = platformId.split(":");
  return thread ? { channel, thread } : { channel };
}

/**
 * Map a Slack event to Mingle's shape. Exported for tests.
 * Channel messages count only when they @ the bot or continue a thread it is in. A mention
 * at the top level opens a thread rooted at that message, and the thread is the chat.
 */
export async function toInbound(
  event: SlackEvent,
  botUserId: string,
  nameOf: (userId: string) => Promise<string>,
  threads: Set<string>,
): Promise<InboundMessage | undefined> {
  if (event.type !== "message") return undefined;
  if (event.subtype && event.subtype !== "file_share" && event.subtype !== "thread_broadcast") return undefined;
  if (!event.user || event.bot_id || event.user === botUserId) return undefined;

  const dm = event.channel_type === "im" || event.channel.startsWith("D");
  const raw = event.text ?? "";
  const mentioned = raw.includes(`<@${botUserId}>`);
  const thread = event.thread_ts && event.thread_ts !== event.ts ? event.thread_ts : undefined;
  const inThread = thread ? threads.has(`${event.channel}:${thread}`) : false;
  const addressed = dm || mentioned || inThread || event.parent_user_id === botUserId;
  if (!addressed) return undefined;

  const root = thread ?? event.ts;
  if (!dm) threads.add(`${event.channel}:${root}`);
  const chat: ChatRef = dm
    ? { platformId: event.channel, kind: "dm" }
    : { platformId: `${event.channel}:${root}`, kind: "thread" };

  let text = raw.replaceAll(`<@${botUserId}>`, "");
  for (const match of [...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)]) {
    text = text.replace(match[0], `@${(await nameOf(match[1] as string)) || match[1]}`);
  }
  text = text
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  const attachments: InboundAttachment[] = (event.files ?? []).map((f) => ({
    id: f.id,
    name: f.name ?? f.title ?? f.id,
    ...(f.size !== undefined ? { size: f.size } : {}),
    ...(f.mimetype ? { mime: f.mimetype } : {}),
  }));

  return {
    platformId: event.ts,
    chat,
    sender: { id: event.user, name: await nameOf(event.user), isBot: false },
    text,
    attachments,
    addressedToBot: true,
    sentAt: Math.round(Number(event.ts) * 1000),
  };
}

function sendFailure(error: unknown): SendResult {
  if (error instanceof SlackError) {
    if (error.code === "ratelimited" || error.status === 429)
      return { kind: "failed", code: "rate_limited", retryable: true };
    if (["channel_not_found", "is_archived", "thread_not_found"].includes(error.code))
      return { kind: "failed", code: "chat_gone", retryable: false };
    if (["not_in_channel", "restricted_action", "cant_update_message", "missing_scope"].includes(error.code))
      return { kind: "failed", code: "forbidden", retryable: false };
    if (["msg_too_long", "too_many_attachments", "invalid_blocks"].includes(error.code))
      return { kind: "failed", code: "too_large", retryable: false };
    return { kind: "failed", code: "unknown", retryable: error.status >= 500 };
  }
  if ((error as Error)?.name === "TimeoutError") return { kind: "uncertain" };
  return { kind: "failed", code: "network", retryable: true };
}
