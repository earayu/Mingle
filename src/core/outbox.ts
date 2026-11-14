import type { ChannelConnection, Degradation, SendResult } from "../channels/channel.ts";
import type { Message, Store } from "../store/store.ts";
import { MingleError, notFound } from "./errors.ts";
import type { LiveReplies } from "./live.ts";

export interface SendRequest {
  readonly chatId: string;
  readonly text: string;
  /** Mingle message ID to quote. */
  readonly replyTo?: string | undefined;
  readonly files?: readonly string[] | undefined;
}

export interface SendReport {
  readonly messages: readonly Message[];
  readonly state: "sent" | "uncertain";
  readonly degraded: readonly Degradation[];
}

/** Everything an agent sends goes through here: lookup, splitting, retries, and marking messages answered. */
export class Outbox {
  private readonly store: Store;
  private readonly live: (connectionId: string) => ChannelConnection | undefined;
  private readonly retryDelaysMs: readonly number[];

  private readonly replies: LiveReplies | undefined;

  constructor(
    store: Store,
    live: (connectionId: string) => ChannelConnection | undefined,
    retryDelaysMs: readonly number[] = [1000, 3000, 9000],
    replies?: LiveReplies,
  ) {
    this.store = store;
    this.live = live;
    this.retryDelaysMs = retryDelaysMs;
    this.replies = replies;
  }

  async send(agentId: string, request: SendRequest): Promise<SendReport> {
    const { store } = this;
    const chat = store.agentChat(agentId, request.chatId);
    if (!chat) throw notFound("chat", request.chatId);
    const connection = store.connection(chat.connectionId);
    const live = this.live(chat.connectionId);
    if (!connection || !live) {
      throw new MingleError(
        "not_connected",
        `the ${connection?.platform ?? "chat app"} connection is offline; it reconnects on its own, try again in a minute`,
        503,
      );
    }
    let quoted: Message | undefined;
    if (request.replyTo) {
      quoted = store.message(request.replyTo);
      if (!quoted || quoted.chatId !== chat.id) throw notFound("message", request.replyTo);
    }
    const text = request.text.trim();
    if (!text && !request.files?.length) {
      throw new MingleError("empty_message", "pass the message body on standard input, or attach a file with --file");
    }

    const chunks = split(text, live.capabilities().maxTextLength);
    const ref = { platformId: chat.platformId, kind: chat.kind, ...(chat.name ? { name: chat.name } : {}) };
    const sent: Message[] = [];
    const degraded = new Set<Degradation>(chunks.length > 1 ? ["text_split"] : []);
    for (const [i, chunk] of chunks.entries()) {
      const last = i === chunks.length - 1;
      const record = store.insertOutbound({
        chatId: chat.id,
        body: chunk,
        replyTo: i === 0 ? (quoted?.id ?? null) : null,
      });
      const files = last && request.files?.length ? request.files.map((path) => ({ path })) : undefined;
      // The first piece of a reply goes into the live reply opened for that message, if any.
      const intoLive = i === 0 && quoted && chunk ? await this.replies?.answer(quoted.id, chunk) : undefined;
      let result: SendResult;
      if (intoLive) {
        result = files
          ? await this.attempt(live, {
              chat: ref,
              text: "",
              files,
              ...(quoted?.platformId ? { replyTo: quoted.platformId } : {}),
            })
          : intoLive;
        if (result.kind === "sent")
          result = { ...result, platformId: intoLive.kind === "sent" ? intoLive.platformId : result.platformId };
      } else {
        result = await this.attempt(live, {
          chat: ref,
          text: chunk,
          ...(i === 0 && quoted?.platformId ? { replyTo: quoted.platformId } : {}),
          ...(files ? { files } : {}),
        });
      }
      if (result.kind === "sent") {
        store.setOutboundResult(record.id, "sent", result.platformId);
        for (const d of result.degraded ?? []) degraded.add(d);
        sent.push(store.message(record.id) as Message);
        continue;
      }
      if (result.kind === "uncertain") {
        store.setOutboundResult(record.id, "uncertain", null);
        sent.push(store.message(record.id) as Message);
        this.markAnswered(chat.id, quoted);
        return { messages: sent, state: "uncertain", degraded: [...degraded] };
      }
      const why = result.detail ? ` (${connection.platform}: ${result.detail})` : "";
      if (result.textSent) {
        // The person has the text; only the files are missing. Say so, so nobody sends it twice.
        store.setOutboundResult(record.id, "sent", result.textSent.platformId);
        this.markAnswered(chat.id, quoted);
        throw new MingleError(
          `send_${result.code}`,
          `the text was delivered but the file was not${why}: ${failureNext(result.code, "file")}. ` +
            "Do not send the text again; send only the file with --file and no text, or tell the person it could not be attached",
          502,
        );
      }
      store.setOutboundResult(record.id, "failed", null);
      throw new MingleError(`send_${result.code}`, `${failureNext(result.code, "message")}${why}`, 502);
    }
    this.markAnswered(chat.id, quoted);
    return { messages: sent, state: "sent", degraded: [...degraded] };
  }

  private async attempt(
    live: ChannelConnection,
    message: Parameters<ChannelConnection["send"]>[0],
  ): Promise<SendResult> {
    let result = await live.send(message);
    // Once the text is out, retries carry only the files.
    const textSent = result.kind === "failed" ? result.textSent : undefined;
    for (const delay of this.retryDelaysMs) {
      if (result.kind !== "failed" || !result.retryable) break;
      await new Promise((r) => setTimeout(r, delay));
      result = await live.send(textSent ? { ...message, text: "" } : message);
    }
    if (!textSent) return result;
    if (result.kind === "sent") return { ...result, platformId: textSent.platformId };
    if (result.kind === "failed") return { ...result, textSent };
    return result;
  }

  /** A reply answers the quoted message; a plain send answers everything pending in that chat. */
  private markAnswered(chatId: string, quoted: Message | undefined): void {
    const answered = quoted
      ? this.store.moveInbound([quoted.id], "reply")
      : this.store.moveInbound(
          this.store
            .chatMessages(chatId, 200)
            .filter((m) => m.direction === "in")
            .map((m) => m.id),
          "send",
        );
    for (const id of answered) this.replies?.settle(id, "answered");
  }
}

function failureNext(code: string, what: "message" | "file"): string {
  switch (code) {
    case "rate_limited":
      return "the chat app is rate limiting; wait a minute before sending again";
    case "forbidden":
      return what === "file"
        ? "the bot lacks permission to share files here, or the workspace blocks this kind of file"
        : "the bot may have been removed from this chat or lacks permission to post";
    case "too_large":
      return "the file is too large for this chat app; send a smaller file or a link";
    case "chat_gone":
      return "this chat no longer exists for the bot";
    default:
      return what === "file" ? "the chat app refused it" : "the message was not sent; try again shortly";
  }
}

/** Split on paragraph, then line, then hard boundaries so each piece fits. */
export function split(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
    const at = cut > max * 0.5 ? cut : max;
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}
