import { randomBytes, randomUUID } from "node:crypto";
import type {
  Capabilities,
  Channel,
  ChannelConnection,
  ChannelEvents,
  ChatRef,
  Credentials,
  InboundMessage,
  OnboardingContext,
  OnboardingEvent,
  OutboundMessage,
  ReactionState,
  SendResult,
} from "../channel.ts";

/**
 * Personal WeChat through Tencent's iLink bot service (ilinkai.weixin.qq.com):
 * scan with the WeChat app, then long-poll for messages. Direct messages only.
 *
 * The protocol details (endpoints, headers, login states, context tokens) follow
 * dsh-im's implementation, src/channels/weixin/weixin-api.mjs,
 * https://github.com/xmanrui/dsh-im (MIT, Copyright (c) xmanrui).
 */

const QR_BASE_URL = "https://ilinkai.weixin.qq.com/";
const PROTOCOL_VERSION = "2.4.6";
const CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;
const BOT_TYPE = "3";
const LONG_POLL_MS = 35_000;
const REQUEST_MS = 15_000;
/** iLink truncates longer texts; the outbox splits at this length. */
const MAX_TEXT = 1800;
const QR_LIFETIME_MS = 8 * 60_000;

const CAPABILITIES: Capabilities = {
  quoteReply: false,
  reactions: false,
  typingIndicator: true,
  fileUpload: false,
  fileDownload: false,
  listMembers: false,
  maxTextLength: MAX_TEXT,
};

type Fetch = typeof fetch;

export class WechatError extends Error {
  readonly code: string;
  readonly providerCode: string | undefined;
  constructor(code: string, message: string, providerCode?: string) {
    super(message);
    this.code = code;
    this.providerCode = providerCode;
  }
}

function isTencentHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "weixin.qq.com" || h.endsWith(".weixin.qq.com") || h === "wechat.com" || h.endsWith(".wechat.com");
}

/** The QR page URL, kept whole (it carries the login ticket), but only on Tencent's hosts. */
export function trustedQrUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WechatError("invalid_qr", "WeChat returned an invalid QR address");
  }
  if (url.protocol !== "https:" || !isTencentHost(url.hostname)) {
    throw new WechatError("untrusted_qr", "WeChat returned a QR address outside Tencent");
  }
  return url.toString();
}

/** Only Tencent's own hosts: a login response must not redirect us elsewhere. */
export function trustedBaseUrl(value: string | undefined, fallback: string): string {
  const raw = value?.trim();
  if (!raw) return fallback;
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new WechatError("untrusted_base_url", "WeChat returned an invalid address");
  }
  if (url.protocol !== "https:" || !isTencentHost(url.hostname) || (url.port !== "" && url.port !== "443")) {
    throw new WechatError("untrusted_base_url", "WeChat returned an address outside Tencent");
  }
  return `${url.origin}${url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`}`;
}

interface WechatItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string };
  image_item?: unknown;
  file_item?: { file_name?: string };
  video_item?: unknown;
}

export interface WechatMessage {
  message_id?: string | number;
  client_id?: string;
  from_user_id?: string;
  message_type?: number;
  context_token?: string;
  create_time_ms?: number;
  item_list?: WechatItem[];
}

export function wechatApi(fetchImpl: Fetch = fetch) {
  async function request<T>(options: {
    method: "GET" | "POST";
    base: string;
    endpoint: string;
    body?: unknown;
    token?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<T> {
    const headers: Record<string, string> = {
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": String(CLIENT_VERSION),
    };
    if (options.token !== undefined) {
      headers["content-type"] = "application/json";
      headers.AuthorizationType = "ilink_bot_token";
      headers["X-WECHAT-UIN"] = Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString("base64");
      headers.Authorization = `Bearer ${options.token}`;
    }
    const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_MS);
    const response = await fetchImpl(new URL(options.endpoint, options.base), {
      method: options.method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
    if (!response.ok) throw new WechatError("http_error", `WeChat HTTP ${response.status}`, String(response.status));
    return (await response.json()) as T;
  }

  const baseInfo = () => ({ channel_version: PROTOCOL_VERSION, bot_agent: "Mingle/0.1" });
  const rejected = (value: { ret?: number | string; errcode?: number | string } | undefined) => {
    for (const field of [value?.ret, value?.errcode]) {
      if (field !== undefined && field !== 0 && field !== "0") return String(field);
    }
    return undefined;
  };

  return {
    rejected,

    async beginLogin(signal?: AbortSignal) {
      const response = await request<{ qrcode?: string; qrcode_img_content?: string; ret?: number; errcode?: number }>({
        method: "POST",
        base: QR_BASE_URL,
        endpoint: `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
        body: { local_token_list: [] },
        timeoutMs: 10_000,
        ...(signal ? { signal } : {}),
      });
      const code = rejected(response);
      if (code) throw new WechatError("qr_rejected", "WeChat refused the QR request", code);
      if (!response.qrcode || !response.qrcode_img_content)
        throw new WechatError("invalid_qr", "WeChat returned no QR code");
      return { qrcode: response.qrcode, url: trustedQrUrl(response.qrcode_img_content) };
    },

    pollLogin(options: { base: string; qrcode: string; verifyCode?: string; signal?: AbortSignal }) {
      let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(options.qrcode)}`;
      if (options.verifyCode) endpoint += `&verify_code=${encodeURIComponent(options.verifyCode)}`;
      return request<{
        status: string;
        bot_token?: string;
        ilink_bot_id?: string;
        ilink_user_id?: string;
        baseurl?: string;
        redirect_host?: string;
      }>({
        method: "GET",
        base: options.base,
        endpoint,
        timeoutMs: LONG_POLL_MS,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    },

    notify(base: string, token: string, which: "start" | "stop") {
      return request<{ ret?: number }>({
        method: "POST",
        base,
        endpoint: `ilink/bot/msg/notify${which}`,
        token,
        body: { base_info: baseInfo() },
        timeoutMs: 10_000,
      });
    },

    async getUpdates(base: string, token: string, cursor: string, signal: AbortSignal) {
      try {
        return await request<{ ret?: number; errcode?: number; msgs?: WechatMessage[]; get_updates_buf?: string }>({
          method: "POST",
          base,
          endpoint: "ilink/bot/getupdates",
          token,
          body: { get_updates_buf: cursor, base_info: baseInfo() },
          timeoutMs: LONG_POLL_MS,
          signal,
        });
      } catch (error) {
        // An idle long poll ends in a timeout; that is not a failure.
        if ((error as Error).name === "TimeoutError" && !signal.aborted)
          return { ret: 0, msgs: [], get_updates_buf: cursor };
        throw error;
      }
    },

    sendText(base: string, token: string, to: string, text: string, contextToken: string | undefined) {
      return request<{ ret?: number; errcode?: number }>({
        method: "POST",
        base,
        endpoint: "ilink/bot/sendmessage",
        token,
        body: {
          msg: {
            from_user_id: "",
            to_user_id: to,
            client_id: `mingle-${randomUUID()}`,
            message_type: 2,
            message_state: 2,
            item_list: [{ type: 1, text_item: { text } }],
            ...(contextToken ? { context_token: contextToken } : {}),
          },
          base_info: baseInfo(),
        },
      });
    },

    async typing(base: string, token: string, to: string, contextToken: string | undefined, on: boolean) {
      const config = await request<{ ret?: number; typing_ticket?: string }>({
        method: "POST",
        base,
        endpoint: "ilink/bot/getconfig",
        token,
        body: { ilink_user_id: to, ...(contextToken ? { context_token: contextToken } : {}), base_info: baseInfo() },
        timeoutMs: 10_000,
      });
      if (!config.typing_ticket) return;
      await request({
        method: "POST",
        base,
        endpoint: "ilink/bot/sendtyping",
        token,
        body: { ilink_user_id: to, typing_ticket: config.typing_ticket, status: on ? 1 : 2, base_info: baseInfo() },
        timeoutMs: 10_000,
      });
    },
  };
}

export type WechatApi = ReturnType<typeof wechatApi>;

export interface WechatOptions {
  readonly api?: WechatApi;
  readonly retryDelayMs?: (attempt: number) => number;
}

export function wechatChannel(options: WechatOptions = {}): Channel {
  const api = options.api ?? wechatApi();
  const retryDelay = options.retryDelayMs ?? ((n: number) => Math.min(2000 * 2 ** (n - 1), 30_000));

  return {
    platform: "wechat",
    onboarding: { kind: "qr" },

    async *onboard(_input, signal, context?: OnboardingContext): AsyncIterable<OnboardingEvent> {
      let login: { qrcode: string; url: string };
      try {
        login = await api.beginLogin(signal);
      } catch {
        yield { kind: "failed", code: signal.aborted ? "cancelled" : "network" };
        return;
      }
      const expiresAt = Date.now() + QR_LIFETIME_MS;
      yield { kind: "qr_ready", qrContent: login.url, expiresAt };

      let base = QR_BASE_URL;
      let verifyCode: string | undefined;
      let codesTried = 0;
      let scanned = false;
      while (!signal.aborted) {
        if (Date.now() > expiresAt) {
          yield { kind: "failed", code: "expired" };
          return;
        }
        let state: Awaited<ReturnType<WechatApi["pollLogin"]>>;
        try {
          state = await api.pollLogin({ base, qrcode: login.qrcode, ...(verifyCode ? { verifyCode } : {}), signal });
        } catch (error) {
          if (signal.aborted) break;
          if ((error as Error).name === "TimeoutError") continue;
          yield { kind: "failed", code: "network" };
          return;
        }
        verifyCode = undefined;
        switch (state.status) {
          case "wait":
            break;
          case "scaned_but_redirect":
            base = trustedBaseUrl(state.redirect_host, base);
            if (!scanned) yield { kind: "scanned" };
            scanned = true;
            break;
          case "scaned":
            if (!scanned) yield { kind: "scanned" };
            scanned = true;
            break;
          case "need_verifycode":
            if (!context?.awaitCode) {
              yield { kind: "failed", code: "unknown" };
              return;
            }
            yield { kind: "needs_code", retry: codesTried > 0 };
            verifyCode = (await context.awaitCode()).trim();
            codesTried++;
            break;
          case "verify_code_blocked":
            yield { kind: "failed", code: "denied" };
            return;
          case "expired":
            yield { kind: "failed", code: "expired" };
            return;
          case "binded_redirect":
            yield { kind: "failed", code: "already_bound" };
            return;
          case "confirmed": {
            if (!state.bot_token || !state.ilink_bot_id || !state.ilink_user_id) {
              yield { kind: "failed", code: "unknown" };
              return;
            }
            yield {
              kind: "succeeded",
              credentials: {
                token: state.bot_token,
                botId: state.ilink_bot_id,
                baseUrl: trustedBaseUrl(state.baseurl, base),
                name: context?.agentName ?? "WeChat",
              },
              bot: { id: state.ilink_bot_id, name: context?.agentName ?? "WeChat" },
              ownerId: state.ilink_user_id,
            };
            return;
          }
          default:
            yield { kind: "failed", code: "unknown" };
            return;
        }
      }
      yield { kind: "failed", code: "cancelled" };
    },

    async connect(credentials: Credentials, events: ChannelEvents): Promise<ChannelConnection> {
      const token = credentials.token ?? "";
      const base = trustedBaseUrl(credentials.baseUrl, QR_BASE_URL);
      const botId = credentials.botId ?? "wechat";
      const stop = new AbortController();
      /** Replies must carry the latest context token from that user. */
      const contexts = new Map<string, string>();
      let cursor = "";

      const started = await api.notify(base, token, "start").catch(() => undefined);
      if (api.rejected(started) === "-14") {
        events.onState({ kind: "error", code: "credentials_revoked" });
      }

      const poll = async () => {
        let failures = 0;
        while (!stop.signal.aborted) {
          try {
            const response = await api.getUpdates(base, token, cursor, stop.signal);
            const code = api.rejected(response);
            if (code === "-14") {
              events.onState({ kind: "error", code: "credentials_revoked" });
              return;
            }
            if (code) throw new WechatError("updates_rejected", "WeChat refused the update request", code);
            if (failures > 0) events.onState({ kind: "connected" });
            failures = 0;
            if (response.get_updates_buf) cursor = response.get_updates_buf;
            for (const message of response.msgs ?? []) {
              const inbound = toInbound(message);
              if (!inbound) continue;
              if (message.context_token) contexts.set(inbound.sender.id, message.context_token);
              events.onMessage(inbound);
            }
          } catch {
            if (stop.signal.aborted) return;
            failures++;
            events.onState({ kind: "reconnecting", attempt: failures });
            await new Promise((r) => setTimeout(r, retryDelay(failures)));
          }
        }
      };
      void poll();

      return {
        bot: { id: botId, name: credentials.name ?? "WeChat" },
        capabilities: () => CAPABILITIES,

        async send(message: OutboundMessage): Promise<SendResult> {
          const to = message.chat.platformId;
          try {
            const response = await api.sendText(base, token, to, message.text, contexts.get(to));
            const code = api.rejected(response);
            if (code === "-14") return { kind: "failed", code: "forbidden", retryable: false };
            if (code) return { kind: "failed", code: "unknown", retryable: false };
            return {
              kind: "sent",
              platformId: `out-${randomUUID()}`,
              degraded: [
                "markdown_flattened",
                ...(message.replyTo ? (["quote_dropped"] as const) : []),
                ...(message.files?.length ? (["files_dropped"] as const) : []),
              ],
            };
          } catch (error) {
            // iLink does not deduplicate: after a timeout the message may have arrived.
            if ((error as Error).name === "TimeoutError") return { kind: "uncertain" };
            if (error instanceof WechatError) return { kind: "failed", code: "unknown", retryable: true };
            return { kind: "failed", code: "network", retryable: true };
          }
        },

        /** WeChat has no reactions: "typing…" stands in while the agent works. */
        async react(chat: ChatRef, _platformMessageId: string, state: ReactionState) {
          const on = state === "processing";
          await api.typing(base, token, chat.platformId, contexts.get(chat.platformId), on).catch(() => {});
        },

        async setTyping(chat: ChatRef, on: boolean) {
          await api.typing(base, token, chat.platformId, contexts.get(chat.platformId), on).catch(() => {});
        },

        async download() {
          throw new Error("receiving files from WeChat is not supported yet");
        },

        async listMembers() {
          return [];
        },

        async close() {
          stop.abort();
          await api.notify(base, token, "stop").catch(() => {});
        },
      };
    },
  };
}

/** Map an iLink message to Mingle's shape. Exported for tests. */
export function toInbound(message: WechatMessage): InboundMessage | undefined {
  // message_type 2 is the bot's own message echoed back.
  if (message.message_type === 2) return undefined;
  const sender = message.from_user_id?.trim();
  const id = message.message_id !== undefined ? String(message.message_id) : message.client_id;
  if (!sender || !id) return undefined;

  const parts: string[] = [];
  for (const item of message.item_list ?? []) {
    if (item.type === 1 && item.text_item?.text?.trim()) parts.push(item.text_item.text.trim());
    else if (item.type === 3 && item.voice_item?.text?.trim()) parts.push(item.voice_item.text.trim());
    else if (item.type === 2) parts.push("[image]");
    else if (item.type === 4) parts.push(`[file: ${item.file_item?.file_name ?? "file"}]`);
    else if (item.type === 5) parts.push("[video]");
  }
  return {
    platformId: id,
    chat: { platformId: sender, kind: "dm" },
    // iLink does not tell bots the sender's nickname.
    sender: { id: sender, name: "", isBot: false },
    text: parts.join("\n"),
    attachments: [],
    addressedToBot: true,
    sentAt: message.create_time_ms ?? Date.now(),
  };
}
