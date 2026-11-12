import { readFile, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type {
  BotIdentity,
  Capabilities,
  Channel,
  ChannelConnection,
  ChannelEvents,
  ChatKind,
  ChatRef,
  Credentials,
  Degradation,
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
 * Discord through the Gateway: the bot opens a WebSocket to Discord, so no public address
 * is needed. Plain REST calls over fetch and Node's global WebSocket; no SDK.
 *
 * Chats: a DM channel is a `dm`, a server text channel a `group`, a thread a `thread`. The
 * chat ID is always the Discord channel ID. In servers, replies quote the message they answer.
 */

type Fetch = typeof fetch;

/** The part of the WebSocket API used here. Node's global WebSocket fits; tests inject a fake. */
export interface SocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number): void;
}

export interface DiscordOptions {
  readonly fetch?: Fetch;
  readonly createSocket?: (url: string) => SocketLike;
  readonly apiBase?: string;
  /** Delay before reconnecting, by attempt. Tests shorten it. */
  readonly backoff?: (attempt: number) => number;
}

const CAPABILITIES: Capabilities = {
  quoteReply: true,
  reactions: true,
  typingIndicator: true,
  fileUpload: true,
  fileDownload: true,
  listMembers: false,
  // A message holds 2,000 characters; leave room for what the adapter adds.
  maxTextLength: 1_900,
};

const INTENT = {
  guilds: 1 << 0,
  guildMessages: 1 << 9,
  directMessages: 1 << 12,
  messageContent: 1 << 15,
};
/** Application flags: the Message Content intent is switched on in the Developer Portal. */
const FLAG_MESSAGE_CONTENT = (1 << 18) | (1 << 19);

/** View Channels, Send Messages, Send Messages in Threads, Embed Links, Attach Files, Read Message History, Add Reactions. */
export const BOT_PERMISSIONS = (
  (1n << 10n) |
  (1n << 11n) |
  (1n << 38n) |
  (1n << 14n) |
  (1n << 15n) |
  (1n << 16n) |
  (1n << 6n)
).toString();

/** Without a boosted server, one upload may be 10 MiB in total. */
const MAX_UPLOAD = 10 * 1024 * 1024;
const MAX_FILES = 10;

const REACTION: Record<Exclude<ReactionState, "none">, string> = { processing: "👀", done: "✅", error: "❌" };

class DiscordError extends Error {
  readonly status: number;
  readonly code: number;
  constructor(status: number, code: number, message: string) {
    super(`Discord: ${status} ${message}`);
    this.status = status;
    this.code = code;
  }
}

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}
interface DiscordAttachment {
  id: string;
  filename: string;
  size?: number;
  url: string;
  content_type?: string;
}
export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  type: number;
  author: DiscordUser;
  member?: { nick?: string | null };
  content: string;
  timestamp: string;
  mentions?: (DiscordUser & { member?: { nick?: string | null } })[];
  attachments?: DiscordAttachment[];
  message_reference?: { message_id?: string };
  referenced_message?: { author?: DiscordUser } | null;
}
interface DiscordChannel {
  id: string;
  type: number;
  name?: string;
  guild_id?: string;
}
interface GatewayPayload {
  op: number;
  d: unknown;
  s?: number | null;
  t?: string | null;
}

type Request = <T>(method: string, path: string, body?: unknown) => Promise<T>;

function displayName(user: DiscordUser, member?: { nick?: string | null }): string {
  return member?.nick || user.global_name || user.username;
}

export function discordChannel(options: DiscordOptions = {}): Channel {
  const fetchImpl = options.fetch ?? fetch;
  const apiBase = options.apiBase ?? "https://discord.com/api/v10";
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
  const backoff = options.backoff ?? ((attempt: number) => Math.min(30_000, 1000 * 2 ** attempt));

  function client(token: string): Request {
    const send = async <T>(method: string, path: string, body?: unknown, retried = false): Promise<T> => {
      const headers: Record<string, string> = { authorization: `Bot ${token}` };
      let payload: FormData | string | undefined;
      if (body instanceof FormData) payload = body;
      else if (body !== undefined) {
        headers["content-type"] = "application/json";
        payload = JSON.stringify(body);
      }
      const response = await fetchImpl(`${apiBase}${path}`, {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        signal: AbortSignal.timeout(body instanceof FormData ? 120_000 : 20_000),
      });
      if (response.status === 204) return undefined as T;
      const json = (await response.json().catch(() => ({}))) as {
        code?: number;
        message?: string;
        retry_after?: number;
      };
      if (response.status === 429 && !retried && (json.retry_after ?? 99) <= 5) {
        await new Promise((r) => setTimeout(r, Math.ceil((json.retry_after ?? 1) * 1000)));
        return send<T>(method, path, body, true);
      }
      if (!response.ok) throw new DiscordError(response.status, json.code ?? 0, json.message ?? "request failed");
      return json as T;
    };
    return (method, path, body) => send(method, path, body);
  }

  async function identify(token: string) {
    const request = client(token);
    const user = await request<DiscordUser>("GET", "/users/@me");
    const app = await request<{
      id: string;
      flags?: number;
      owner?: { id: string };
      team?: { owner_user_id?: string } | null;
    }>("GET", "/oauth2/applications/@me");
    return { user, app };
  }

  return {
    platform: "discord",
    onboarding: {
      kind: "credentials",
      setupUrl: "https://discord.com/developers/applications",
      fields: [{ key: "token", labelKey: "discord.token", secret: true }],
    },

    inviteUrl(bot: BotIdentity) {
      return `https://discord.com/oauth2/authorize?client_id=${bot.id}&scope=bot&permissions=${BOT_PERMISSIONS}`;
    },

    async *onboard(input: Credentials | undefined): AsyncIterable<OnboardingEvent> {
      const token = (input?.token ?? "").trim().replace(/^Bot\s+/i, "");
      if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
        yield { kind: "failed", code: "invalid_credentials" };
        return;
      }
      try {
        const { user, app } = await identify(token);
        const name = displayName(user);
        const ownerId = app.team ? app.team.owner_user_id : app.owner?.id;
        yield {
          kind: "succeeded",
          credentials: { token, name },
          bot: { id: user.id, name },
          ...(ownerId ? { ownerId } : {}),
        };
      } catch (error) {
        yield {
          kind: "failed",
          code: error instanceof DiscordError && error.status === 401 ? "invalid_credentials" : "network",
        };
      }
    },

    async connect(credentials: Credentials, events: ChannelEvents): Promise<ChannelConnection> {
      const token = credentials.token ?? "";
      const request = client(token);
      const { user, app } = await identify(token);
      const bot: BotIdentity = { id: user.id, name: credentials.name ?? displayName(user) };
      let messageContent = ((app.flags ?? 0) & FLAG_MESSAGE_CONTENT) !== 0;

      /** Channel kinds and names; filled from GUILD_CREATE and looked up on demand. */
      const channels = new Map<string, { kind: ChatKind; name?: string }>();
      const guilds = new Map<string, string>();
      const files = new Map<string, DiscordAttachment>();

      const learnChannel = (c: DiscordChannel) => {
        const guild = c.guild_id ? guilds.get(c.guild_id) : undefined;
        const kind: ChatKind = c.type === 1 || c.type === 3 ? "dm" : [10, 11, 12].includes(c.type) ? "thread" : "group";
        const name = c.name ? (guild ? `${guild} #${c.name}` : `#${c.name}`) : undefined;
        channels.set(c.id, { kind, ...(name ? { name } : {}) });
      };
      const chatOf = async (message: DiscordMessage): Promise<ChatRef> => {
        if (!message.guild_id) return { platformId: message.channel_id, kind: "dm" };
        let known = channels.get(message.channel_id);
        if (!known) {
          const fetched = await request<DiscordChannel>("GET", `/channels/${message.channel_id}`).catch(
            () => undefined,
          );
          if (fetched) learnChannel({ ...fetched, guild_id: fetched.guild_id ?? message.guild_id });
          known = channels.get(message.channel_id) ?? { kind: "group" };
        }
        return { platformId: message.channel_id, kind: known.kind, ...(known.name ? { name: known.name } : {}) };
      };

      // ------------------------------------------------------------ gateway
      let socket: SocketLike | undefined;
      let closed = false;
      let attempt = 0;
      let seq: number | null = null;
      let sessionId: string | undefined;
      let resumeUrl: string | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let firstBeat: ReturnType<typeof setTimeout> | undefined;
      let acked = true;
      let gatewayUrl: string | undefined;

      const stopHeartbeat = () => {
        clearInterval(heartbeat);
        clearTimeout(firstBeat);
      };
      const scheduleReconnect = () => {
        if (closed) return;
        attempt++;
        events.onState({ kind: "reconnecting", attempt });
        setTimeout(() => void open(), backoff(attempt)).unref?.();
      };

      const handleDispatch = async (type: string, data: unknown) => {
        if (type === "READY") {
          const ready = data as { session_id: string; resume_gateway_url: string };
          sessionId = ready.session_id;
          resumeUrl = ready.resume_gateway_url;
        } else if (type === "GUILD_CREATE") {
          const guild = data as { id: string; name: string; channels?: DiscordChannel[]; threads?: DiscordChannel[] };
          guilds.set(guild.id, guild.name);
          for (const c of [...(guild.channels ?? []), ...(guild.threads ?? [])])
            learnChannel({ ...c, guild_id: guild.id });
        } else if (
          type === "CHANNEL_CREATE" ||
          type === "CHANNEL_UPDATE" ||
          type === "THREAD_CREATE" ||
          type === "THREAD_UPDATE"
        ) {
          learnChannel(data as DiscordChannel);
        } else if (type === "MESSAGE_CREATE") {
          const message = data as DiscordMessage;
          if (message.author.id === bot.id) return;
          const inbound = toInbound(message, bot.id, await chatOf(message));
          if (!inbound) return;
          for (const a of message.attachments ?? []) files.set(a.id, a);
          if (files.size > 5000) files.delete(files.keys().next().value as string);
          events.onMessage(inbound);
        }
      };

      const open = async (): Promise<void> => {
        if (closed) return;
        stopHeartbeat();
        const resuming = Boolean(sessionId && resumeUrl);
        if (!resuming && !gatewayUrl) {
          try {
            gatewayUrl = (await request<{ url: string }>("GET", "/gateway/bot")).url;
          } catch (error) {
            if (error instanceof DiscordError && error.status === 401) {
              events.onState({ kind: "error", code: "credentials_revoked" });
              return;
            }
            scheduleReconnect();
            return;
          }
        }
        const ws = createSocket(`${resuming ? resumeUrl : gatewayUrl}/?v=10&encoding=json`);
        socket = ws;
        const sendOp = (op: number, d: unknown) => ws.send(JSON.stringify({ op, d }));
        const beat = () => {
          if (!acked) {
            // No ACK since the last beat: the connection is a zombie. Close and resume.
            ws.close(4000);
            return;
          }
          acked = false;
          sendOp(1, seq);
        };
        ws.onmessage = (event) => {
          let payload: GatewayPayload;
          try {
            payload = JSON.parse(String(event.data)) as GatewayPayload;
          } catch {
            return;
          }
          if (typeof payload.s === "number") seq = payload.s;
          switch (payload.op) {
            case 10: {
              const interval = (payload.d as { heartbeat_interval: number }).heartbeat_interval;
              acked = true;
              firstBeat = setTimeout(() => {
                beat();
                heartbeat = setInterval(beat, interval);
                heartbeat.unref?.();
              }, interval * Math.random());
              firstBeat.unref?.();
              if (sessionId && resumeUrl) sendOp(6, { token, session_id: sessionId, seq });
              else
                sendOp(2, {
                  token,
                  intents:
                    INTENT.guilds |
                    INTENT.guildMessages |
                    INTENT.directMessages |
                    (messageContent ? INTENT.messageContent : 0),
                  properties: { os: process.platform, browser: "mingle", device: "mingle" },
                });
              break;
            }
            case 11:
              acked = true;
              break;
            case 1:
              sendOp(1, seq);
              break;
            case 7: // Discord asks for a reconnect: resume on a new socket.
              ws.close(4000);
              break;
            case 9: // Invalid session: resume if Discord allows it, otherwise start over.
              if (!payload.d) {
                sessionId = undefined;
                resumeUrl = undefined;
                seq = null;
              }
              ws.close(4000);
              break;
            case 0:
              if (payload.t === "READY" || payload.t === "RESUMED") {
                if (attempt > 0) events.onState({ kind: "connected" });
                attempt = 0;
              }
              void handleDispatch(payload.t ?? "", payload.d).catch(() => {});
              break;
          }
        };
        ws.onclose = (event) => {
          if (socket !== ws) return;
          stopHeartbeat();
          if (closed) return;
          const code = event?.code ?? 0;
          if (code === 4004) return events.onState({ kind: "error", code: "credentials_revoked" });
          if (code === 4014 && messageContent) {
            // The Message Content intent was switched off: carry on with @-mentions and DMs only.
            messageContent = false;
            sessionId = undefined;
            resumeUrl = undefined;
          } else if (code === 4014) return events.onState({ kind: "error", code: "permission_missing" });
          else if ([4010, 4011, 4012, 4013].includes(code)) return events.onState({ kind: "error", code: "unknown" });
          if (code === 4007 || code === 4009) {
            sessionId = undefined;
            resumeUrl = undefined;
            seq = null;
          }
          scheduleReconnect();
        };
        ws.onerror = () => {};
      };
      await open();

      // ----------------------------------------------------------- sending
      const post = async (
        chat: ChatRef,
        text: string,
        replyTo: string | undefined,
        attachments: { path: string; name?: string }[] = [],
      ): Promise<{ id: string; degraded: Degradation[] }> => {
        const degraded: Degradation[] = [];
        const body: Record<string, unknown> = {
          ...(text ? { content: text } : {}),
          // Only real people can be pinged: no @everyone or role mentions from an agent's text.
          allowed_mentions: { parse: ["users"], replied_user: chat.kind !== "dm" },
          ...(replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}),
        };
        let payload: unknown = body;
        if (attachments.length) {
          const form = new FormData();
          const meta: { id: number; filename: string }[] = [];
          let total = 0;
          for (const file of attachments) {
            const { size } = await stat(file.path);
            if (meta.length >= MAX_FILES || total + size > MAX_UPLOAD) {
              degraded.push("files_dropped");
              continue;
            }
            total += size;
            const name = file.name ?? basename(file.path);
            form.append(`files[${meta.length}]`, new Blob([await readFile(file.path)]), name);
            meta.push({ id: meta.length, filename: name });
          }
          if (meta.length) {
            form.append("payload_json", JSON.stringify({ ...body, attachments: meta }));
            payload = form;
          }
          if (!meta.length && !text) {
            return { id: "", degraded: ["files_dropped"] };
          }
        }
        const sent = await request<{ id: string }>("POST", `/channels/${chat.platformId}/messages`, payload);
        return { id: sent.id, degraded: [...new Set(degraded)] };
      };
      const edit = (chat: ChatRef, id: string, content: string) =>
        request("PATCH", `/channels/${chat.platformId}/messages/${id}`, {
          content,
          allowed_mentions: { parse: ["users"] },
        });
      const reaction = (chat: ChatRef, id: string, emoji: string, method: "PUT" | "DELETE") =>
        request(method, `/channels/${chat.platformId}/messages/${id}/reactions/${encodeURIComponent(emoji)}/@me`).catch(
          () => {},
        );

      return {
        bot,
        capabilities: () => CAPABILITIES,

        async send(message: OutboundMessage): Promise<SendResult> {
          try {
            const sent = await post(message.chat, message.text.trim(), message.replyTo, [...(message.files ?? [])]);
            if (!sent.id) return { kind: "failed", code: "too_large", retryable: false };
            return {
              kind: "sent",
              platformId: sent.id,
              ...(sent.degraded.length ? { degraded: sent.degraded } : {}),
            };
          } catch (error) {
            return sendFailure(error);
          }
        },

        async react(chat: ChatRef, platformMessageId: string, state: ReactionState) {
          if (state === "processing") return void (await reaction(chat, platformMessageId, REACTION.processing, "PUT"));
          await reaction(chat, platformMessageId, REACTION.processing, "DELETE");
          if (state === "done" || state === "error") await reaction(chat, platformMessageId, REACTION[state], "PUT");
        },

        /** A placeholder reply, edited as progress comes in and finally replaced by the answer. */
        async startLive(chat: ChatRef, live: LiveOptions): Promise<LiveReply> {
          const { id } = await post(chat, live.initial, live.replyTo);
          let last = live.initial;
          return {
            update: async (markdown) => {
              if (markdown === last) return;
              last = markdown;
              await edit(chat, id, markdown).catch(() => {});
            },
            finish: async (markdown) => {
              try {
                await edit(chat, id, markdown);
                return { kind: "sent", platformId: id };
              } catch (error) {
                return sendFailure(error);
              }
            },
          };
        },

        /** Shows "is typing…" for about ten seconds. */
        async setTyping(chat: ChatRef, typing: boolean) {
          if (typing) await request("POST", `/channels/${chat.platformId}/typing`).catch(() => {});
        },

        async download(attachment: InboundAttachment, toPath: string) {
          const file = files.get(attachment.id);
          if (!file) throw new Error("this file is no longer available; ask for it to be sent again");
          const response = await fetchImpl(file.url, { signal: AbortSignal.timeout(120_000) });
          if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
          await writeFile(toPath, Buffer.from(await response.arrayBuffer()));
        },

        /** Works once the user shares a server with the bot. */
        async messageUser(userId: string, text: string) {
          const dm = await request<{ id: string }>("POST", "/users/@me/channels", { recipient_id: userId });
          await request("POST", `/channels/${dm.id}/messages`, { content: text, allowed_mentions: { parse: [] } });
        },

        async listMembers() {
          return [];
        },

        async close() {
          closed = true;
          stopHeartbeat();
          socket?.close(1000);
        },
      };
    },
  };
}

/**
 * Map a Discord message to Mingle's shape. Exported for tests.
 * Server messages are all kept as context; they trigger the agent when they @ the bot or
 * reply to it. Without the Message Content intent Discord only sends text for those anyway.
 */
export function toInbound(message: DiscordMessage, botId: string, chat: ChatRef): InboundMessage | undefined {
  // 0 is a normal message, 19 a reply. Joins, pins and the like are not conversation.
  if (message.type !== 0 && message.type !== 19) return undefined;
  if (message.author.id === botId) return undefined;
  const mentioned = (message.mentions ?? []).some((u) => u.id === botId);
  const repliedToMe = message.referenced_message?.author?.id === botId;

  let text = message.content.replace(new RegExp(`<@!?${botId}>`, "g"), "");
  for (const u of message.mentions ?? []) {
    if (u.id === botId) continue;
    text = text.replace(new RegExp(`<@!?${u.id}>`, "g"), `@${displayName(u, u.member)}`);
  }
  text = text.replace(/[ \t]{2,}/g, " ").trim();

  const attachments: InboundAttachment[] = (message.attachments ?? []).map((a) => ({
    id: a.id,
    name: a.filename,
    ...(a.size !== undefined ? { size: a.size } : {}),
    ...(a.content_type ? { mime: a.content_type } : {}),
  }));

  return {
    platformId: message.id,
    chat,
    sender: {
      id: message.author.id,
      name: displayName(message.author, message.member),
      isBot: Boolean(message.author.bot),
    },
    text,
    attachments,
    ...(message.message_reference?.message_id ? { replyTo: message.message_reference.message_id } : {}),
    addressedToBot: chat.kind === "dm" || mentioned || repliedToMe,
    sentAt: Date.parse(message.timestamp) || Date.now(),
  };
}

function sendFailure(error: unknown): SendResult {
  if (error instanceof DiscordError) {
    if (error.status === 429) return { kind: "failed", code: "rate_limited", retryable: true };
    if (error.status === 413 || error.code === 40005 || error.code === 50035)
      return { kind: "failed", code: "too_large", retryable: false };
    if (error.status === 404 || error.code === 10003) return { kind: "failed", code: "chat_gone", retryable: false };
    if (error.status === 403) return { kind: "failed", code: "forbidden", retryable: false };
    return { kind: "failed", code: "unknown", retryable: error.status >= 500 };
  }
  if ((error as Error)?.name === "TimeoutError") return { kind: "uncertain" };
  return { kind: "failed", code: "network", retryable: true };
}
