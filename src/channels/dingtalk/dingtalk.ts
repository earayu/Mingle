import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";
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
 * DingTalk (钉钉): app created by scanning (device registration), messages over the
 * Stream connection (no public address), replies through the robot OpenAPI, and an
 * AI card for the live progress view.
 *
 * Endpoints, the shared AI card template and the text-reaction parameters follow
 * dsh-im's implementation, src/channels/dingtalk/, https://github.com/xmanrui/dsh-im
 * (MIT, Copyright (c) xmanrui).
 */

const REGISTRATION_BASE = "https://oapi.dingtalk.com";
const API_BASE = "https://api.dingtalk.com";
/** DingTalk's shared AI card template (streaming markdown in msgContent). */
const AI_CARD_TEMPLATE = "02fcf2f4-5e02-4a85-b672-46d1f715543e.schema";
const THINKING = "🤔思考中";
const TEXT_REACTION_ID = "2659900";
const TEXT_REACTION_BACKGROUND = "im_bg_1";
const QR_MAX_MS = 15 * 60_000;

const CAPABILITIES: Capabilities = {
  quoteReply: false,
  reactions: true,
  typingIndicator: false,
  fileUpload: false,
  fileDownload: true,
  listMembers: false,
  maxTextLength: 5000,
};

type Fetch = typeof fetch;

export interface DingtalkMessage {
  msgId: string;
  conversationId: string;
  conversationType: string; // "1" direct, "2" group
  conversationTitle?: string;
  senderStaffId?: string;
  senderId?: string;
  senderNick?: string;
  isInAtList?: boolean;
  createAt?: number;
  robotCode?: string;
  msgtype: string;
  text?: { content?: string };
  content?: {
    downloadCode?: string;
    fileName?: string;
    recognition?: string;
    richText?: { text?: string; downloadCode?: string; type?: string }[];
  };
}

/** The Stream client surface used here. Injected so tests run offline. */
export interface StreamClientLike {
  registerCallbackListener(
    topic: string,
    callback: (event: { headers: { messageId: string }; data: string }) => void,
  ): unknown;
  socketCallBackResponse(messageId: string, result: unknown): void;
  connect(): Promise<void>;
  disconnect(): void;
}

export function dingtalkApi(fetchImpl: Fetch = fetch) {
  const tokens = new Map<string, { token: string; until: number }>();

  async function json<T>(url: string, init: RequestInit): Promise<T> {
    const response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => ({}))) as T & { errcode?: number; code?: string; message?: string };
    if (!response.ok || (body.errcode !== undefined && body.errcode !== 0)) {
      throw Object.assign(new Error(`DingTalk ${response.status} ${body.code ?? body.errcode ?? ""}`), {
        status: response.status,
      });
    }
    return body;
  }

  async function token(appKey: string, appSecret: string): Promise<string> {
    const cached = tokens.get(appKey);
    if (cached && cached.until > Date.now()) return cached.token;
    const body = await json<{ accessToken?: string; expireIn?: number }>(`${API_BASE}/v1.0/oauth2/accessToken`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appKey, appSecret }),
    });
    if (!body.accessToken) throw new Error("DingTalk returned no access token");
    tokens.set(appKey, {
      token: body.accessToken,
      until: Date.now() + Math.max(60, (body.expireIn ?? 7200) - 60) * 1000,
    });
    return body.accessToken;
  }

  const call = async <T>(c: { appKey: string; appSecret: string }, path: string, body: unknown, method = "POST") =>
    json<T>(`${API_BASE}/${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-acs-dingtalk-access-token": await token(c.appKey, c.appSecret),
      },
      body: JSON.stringify(body),
    });

  return {
    token,
    call,
    register: {
      async begin(signal?: AbortSignal) {
        const post = <T>(path: string, body: unknown) =>
          json<T>(`${REGISTRATION_BASE}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            ...(signal ? { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) } : {}),
          });
        const init = await post<{ nonce?: string }>("/app/registration/init", { source: "MINGLE" });
        if (!init.nonce) throw new Error("DingTalk returned no nonce");
        const begun = await post<{
          device_code?: string;
          verification_uri_complete?: string;
          expires_in?: number;
          interval?: number;
        }>("/app/registration/begin", { nonce: init.nonce });
        if (!begun.device_code || !begun.verification_uri_complete) throw new Error("DingTalk returned no QR");
        const url = new URL(begun.verification_uri_complete);
        if (url.protocol !== "https:" || !(url.hostname === "dingtalk.com" || url.hostname.endsWith(".dingtalk.com"))) {
          throw new Error("DingTalk returned a QR outside dingtalk.com");
        }
        return {
          deviceCode: begun.device_code,
          url: url.toString(),
          expiresInMs: Math.min((begun.expires_in ?? 600) * 1000, QR_MAX_MS),
          intervalMs: Math.max(1, begun.interval ?? 5) * 1000,
        };
      },
      poll(deviceCode: string, signal?: AbortSignal) {
        return json<{ status?: string; client_id?: string; client_secret?: string }>(
          `${REGISTRATION_BASE}/app/registration/poll`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ device_code: deviceCode }),
            ...(signal ? { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) } : {}),
          },
        );
      },
    },
  };
}

export type DingtalkApi = ReturnType<typeof dingtalkApi>;

export interface DingtalkOptions {
  readonly api?: DingtalkApi;
  readonly createClient?: (credentials: { clientId: string; clientSecret: string }) => StreamClientLike;
}

export function dingtalkChannel(options: DingtalkOptions = {}): Channel {
  const api = options.api ?? dingtalkApi();
  const create =
    options.createClient ??
    ((c) =>
      new DWClient({
        clientId: c.clientId,
        clientSecret: c.clientSecret,
        keepAlive: true,
      }) as unknown as StreamClientLike);

  return {
    platform: "dingtalk",
    onboarding: { kind: "qr", desktopLink: true },
    manualFields: [
      { key: "clientId", labelKey: "dingtalk.clientId", secret: false },
      { key: "clientSecret", labelKey: "dingtalk.clientSecret", secret: true },
    ],

    async *onboard(input, signal, context): AsyncIterable<OnboardingEvent> {
      const name = context?.agentName ?? "DingTalk bot";
      if (input?.clientId && input.clientSecret) {
        try {
          await api.token(input.clientId, input.clientSecret);
          yield {
            kind: "succeeded",
            credentials: { clientId: input.clientId, clientSecret: input.clientSecret, name },
            bot: { id: input.clientId, name },
          };
        } catch {
          yield { kind: "failed", code: "invalid_credentials" };
        }
        return;
      }

      let attempt: Awaited<ReturnType<DingtalkApi["register"]["begin"]>>;
      try {
        attempt = await api.register.begin(signal);
      } catch {
        yield { kind: "failed", code: signal.aborted ? "cancelled" : "network" };
        return;
      }
      const deadline = Date.now() + attempt.expiresInMs;
      yield { kind: "qr_ready", qrContent: attempt.url, expiresAt: deadline };
      while (!signal.aborted && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, attempt.intervalMs));
        if (signal.aborted) break;
        let state: { status?: string; client_id?: string; client_secret?: string };
        try {
          state = await api.register.poll(attempt.deviceCode, signal);
        } catch {
          continue;
        }
        const status = String(state.status ?? "").toUpperCase();
        if (status === "SUCCESS" && state.client_id && state.client_secret) {
          yield {
            kind: "succeeded",
            credentials: { clientId: state.client_id, clientSecret: state.client_secret, name },
            bot: { id: state.client_id, name },
          };
          return;
        }
        if (status === "EXPIRED") {
          yield { kind: "failed", code: "expired" };
          return;
        }
        if (status === "FAIL") {
          yield { kind: "failed", code: "denied" };
          return;
        }
      }
      yield { kind: "failed", code: signal.aborted ? "cancelled" : "expired" };
    },

    async connect(credentials: Credentials, events: ChannelEvents): Promise<ChannelConnection> {
      const keys = { appKey: credentials.clientId ?? "", appSecret: credentials.clientSecret ?? "" };
      // For apps created by registration the robot code is the client ID.
      const robotCode = credentials.robotCode ?? keys.appKey;
      await api.token(keys.appKey, keys.appSecret);
      const client = create({ clientId: keys.appKey, clientSecret: keys.appSecret });
      /** Per inbound message: the conversation it came from and who sent it. */
      const origins = new Map<string, { conversationId: string; staffId?: string; nick?: string }>();

      client.registerCallbackListener(TOPIC_ROBOT, (event) => {
        try {
          client.socketCallBackResponse(event.headers.messageId, { success: true });
        } catch {}
        let message: DingtalkMessage;
        try {
          message = JSON.parse(event.data) as DingtalkMessage;
        } catch {
          return;
        }
        const inbound = toInbound(message);
        if (!inbound) return;
        origins.set(inbound.platformId, {
          conversationId: message.conversationId,
          ...(message.senderStaffId ? { staffId: message.senderStaffId } : {}),
          ...(message.senderNick ? { nick: message.senderNick } : {}),
        });
        if (origins.size > 2000) origins.delete(origins.keys().next().value as string);
        events.onMessage(inbound);
      });
      await client.connect();

      const sendMarkdown = async (chat: ChatRef, text: string) => {
        const msgParam = JSON.stringify({ title: text.split("\n")[0]?.slice(0, 40) || "Mingle", text });
        if (chat.kind === "dm") {
          await api.call(keys, "v1.0/robot/oToMessages/batchSend", {
            robotCode,
            userIds: [chat.platformId],
            msgKey: "sampleMarkdown",
            msgParam,
          });
        } else {
          await api.call(keys, "v1.0/robot/groupMessages/send", {
            robotCode,
            openConversationId: chat.platformId,
            msgKey: "sampleMarkdown",
            msgParam,
          });
        }
      };

      const emotion = async (platformMessageId: string, action: "reply" | "recall") => {
        const origin = origins.get(platformMessageId);
        if (!origin) return;
        await api.call(keys, `v1.0/robot/emotion/${action}`, {
          robotCode,
          openMsgId: platformMessageId,
          openConversationId: origin.conversationId,
          emotionType: 2,
          emotionName: THINKING,
          textEmotion: {
            emotionId: TEXT_REACTION_ID,
            emotionName: THINKING,
            text: THINKING,
            backgroundId: TEXT_REACTION_BACKGROUND,
          },
        });
      };

      return {
        bot: { id: keys.appKey, name: credentials.name ?? "DingTalk bot" },
        capabilities: () => CAPABILITIES,

        async send(message: OutboundMessage): Promise<SendResult> {
          try {
            if (message.text) await sendMarkdown(message.chat, message.text);
            return {
              kind: "sent",
              platformId: `out-${randomUUID()}`,
              degraded: [
                ...(message.replyTo ? (["quote_dropped"] as const) : []),
                ...(message.files?.length ? (["files_dropped"] as const) : []),
              ],
            };
          } catch (error) {
            const status = (error as { status?: number }).status ?? 0;
            if (status === 429) return { kind: "failed", code: "rate_limited", retryable: true };
            if (status === 403) return { kind: "failed", code: "forbidden", retryable: false };
            return {
              kind: "failed",
              code: status >= 500 ? "unknown" : "network",
              retryable: status >= 500 || status === 0,
            };
          }
        },

        /** DingTalk shows a "🤔思考中" tag on the message while the agent works; it is removed once done. */
        async react(_chat: ChatRef, platformMessageId: string, state: ReactionState) {
          await emotion(platformMessageId, state === "processing" ? "reply" : "recall").catch(() => {});
        },

        async startLive(chat: ChatRef, live: LiveOptions): Promise<LiveReply> {
          const outTrackId = `mingle_${randomUUID()}`;
          const origin = origins.get(live.replyTo);
          const atUserIds = chat.kind !== "dm" && origin?.staffId ? { [origin.staffId]: origin.nick ?? "" } : undefined;
          const withMention = (text: string) =>
            atUserIds
              ? `${Object.entries(atUserIds)
                  .map(([id, nick]) => `<a atId="${id}">@${nick}</a>`)
                  .join(" ")} ${text}`
              : text;
          const data = (text: string, flowStatus: string) => ({
            cardParamMap: {
              flowStatus,
              msgContent: text,
              staticMsgContent: "",
              sys_full_json_obj: JSON.stringify({ order: ["msgContent"] }),
              config: JSON.stringify({ autoLayout: true }),
            },
          });
          const deliver =
            chat.kind === "dm"
              ? {
                  openSpaceId: `dtv1.card//IM_ROBOT.${chat.platformId}`,
                  imRobotOpenDeliverModel: { spaceType: "IM_ROBOT", robotCode },
                }
              : {
                  openSpaceId: `dtv1.card//IM_GROUP.${chat.platformId}`,
                  imGroupOpenDeliverModel: { robotCode, ...(atUserIds ? { atUserIds } : {}) },
                };
          await api.call(keys, "v1.0/card/instances/createAndDeliver", {
            ...deliver,
            outTrackId,
            userIdType: 1,
            cardTemplateId: AI_CARD_TEMPLATE,
            cardData: data(live.initial, "2"),
            callbackType: "STREAM",
            imGroupOpenSpaceModel: { supportForward: true },
            imRobotOpenSpaceModel: { supportForward: true },
          });
          const stream = (content: string, isFinalize: boolean) =>
            api.call(
              keys,
              "v1.0/card/streaming",
              { outTrackId, guid: randomUUID(), key: "msgContent", content, isFull: true, isFinalize, isError: false },
              "PUT",
            );
          return {
            update: async (markdown) => {
              await stream(markdown, false).catch(() => {});
            },
            finish: async (markdown) => {
              try {
                const text = withMention(markdown);
                await stream(text, true);
                await api.call(
                  keys,
                  "v1.0/card/instances",
                  { outTrackId, cardData: data(text, "3"), cardUpdateOptions: { updateCardDataByKey: true } },
                  "PUT",
                );
                return { kind: "sent", platformId: outTrackId };
              } catch {
                return { kind: "failed", code: "unknown", retryable: false };
              }
            },
          };
        },

        async setTyping() {},

        async download(attachment: InboundAttachment, toPath: string) {
          const { downloadUrl } = await api.call<{ downloadUrl?: string }>(keys, "v1.0/robot/messageFiles/download", {
            downloadCode: attachment.id,
            robotCode,
          });
          if (!downloadUrl) throw new Error("DingTalk returned no download address");
          const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(120_000) });
          if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
          await writeFile(toPath, Buffer.from(await response.arrayBuffer()));
        },

        async listMembers() {
          return [];
        },

        async close() {
          client.disconnect();
        },
      };
    },
  };
}

/** Map a DingTalk robot callback to Mingle's shape. Exported for tests. */
export function toInbound(message: DingtalkMessage): InboundMessage | undefined {
  if (!message.msgId || !message.conversationId) return undefined;
  const dm = message.conversationType === "1";
  const senderId = message.senderStaffId ?? message.senderId ?? "";
  if (!senderId) return undefined;
  const parts: string[] = [];
  const attachments: InboundAttachment[] = [];
  if (message.text?.content) parts.push(message.text.content.trim());
  if (message.msgtype === "audio" && message.content?.recognition) parts.push(message.content.recognition);
  if (message.msgtype === "picture" && message.content?.downloadCode) {
    attachments.push({ id: message.content.downloadCode, name: `image-${message.msgId}.png`, mime: "image/png" });
  }
  if (message.msgtype === "file" && message.content?.downloadCode) {
    attachments.push({ id: message.content.downloadCode, name: message.content.fileName ?? `file-${message.msgId}` });
  }
  for (const item of message.content?.richText ?? []) {
    if (item.text) parts.push(item.text);
    if (item.downloadCode)
      attachments.push({
        id: item.downloadCode,
        name: `image-${message.msgId}-${attachments.length}.png`,
        mime: "image/png",
      });
  }
  return {
    platformId: message.msgId,
    // Direct chats are addressed by the sender's staff ID, which is what the send API takes.
    chat: dm
      ? { platformId: senderId, kind: "dm", ...(message.senderNick ? { name: message.senderNick } : {}) }
      : {
          platformId: message.conversationId,
          kind: "group",
          ...(message.conversationTitle ? { name: message.conversationTitle } : {}),
        },
    sender: { id: senderId, name: message.senderNick ?? "", isBot: false },
    text: parts.join("\n").trim(),
    attachments,
    // In groups DingTalk only forwards messages that @ the bot.
    addressedToBot: dm || message.isInAtList !== false,
    sentAt: message.createAt ?? Date.now(),
  };
}
