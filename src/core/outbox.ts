import { statSync } from "node:fs";
import { basename } from "node:path";
import type { ChannelConnection, ChatRef, Degradation, SendResult } from "../channels/channel.ts";
import { codeRanges, type Mention, mentionSpots } from "../channels/mention.ts";
import type { Contact, Message, Store } from "../store/store.ts";
import { MingleError, notFound } from "./errors.ts";
import type { LiveReplies } from "./live.ts";

export interface SendRequest {
  readonly chatId: string;
  readonly text: string;
  /** Mingle message ID to quote. */
  readonly replyTo?: string | undefined;
  readonly files?: readonly string[] | undefined;
  /** Mingle's own word in the chat, not the agent's answer: it settles none of the chat's messages. */
  readonly notice?: boolean;
  /** Sent by the line working on this task (docs/spec.md 4.13): replies to it go back to that line. */
  readonly lineTaskId?: string | undefined;
  /**
   * Reply to `replyTo` in a thread under it, opening one where the chat app can (docs/spec.md 4.13).
   * `title` names the thread where threads have names. Elsewhere a plain reply.
   */
  readonly inThread?: { readonly title: string } | undefined;
  /** An outcome for the whole chat, not only the thread under `replyTo` (`OutboundMessage.inChat`). */
  readonly inChat?: boolean | undefined;
}

export interface SendReport {
  readonly messages: readonly Message[];
  readonly state: "sent" | "uncertain";
  readonly degraded: readonly Degradation[];
  /** The people the text @-mentions, by contact ID and the name as written. */
  readonly mentioned: readonly { readonly contact: string; readonly name: string }[];
  /** `@words` that are nobody here: they went out as plain text. */
  readonly unmatched: readonly string[];
  /** The thread the message went into, when sending it opened one (`SendRequest.inThread`). */
  readonly thread?: string;
}

/** Everything an agent sends goes through here: lookup, splitting, retries, and marking messages answered. */
export class Outbox {
  private readonly store: Store;
  private readonly live: (connectionId: string) => ChannelConnection | undefined;
  private readonly retryDelaysMs: readonly number[];

  private readonly replies: LiveReplies | undefined;
  /** Whether the harness only queued a message behind the agent's running turn (unseen so far). */
  private readonly queued: (agentId: string, messageId: string) => boolean;

  constructor(
    store: Store,
    live: (connectionId: string) => ChannelConnection | undefined,
    retryDelaysMs: readonly number[] = [1000, 3000, 9000],
    replies?: LiveReplies,
    queued: (agentId: string, messageId: string) => boolean = () => false,
  ) {
    this.store = store;
    this.live = live;
    this.retryDelaysMs = retryDelaysMs;
    this.replies = replies;
    this.queued = queued;
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

    // `@name` in a group is a mention of whoever has that name there (docs/spec.md 4.2).
    const found =
      chat.kind !== "dm" && !request.notice && text.includes("@")
        ? resolveMentions(text, store.mentionCandidates(chat))
        : { mentions: [], mentioned: [], unmatched: [] };
    const mentions = found.mentions.length ? { mentions: found.mentions } : {};
    const chunks = split(text, live.capabilities().maxTextLength);
    let ref: ChatRef = { platformId: chat.platformId, kind: chat.kind, ...(chat.name ? { name: chat.name } : {}) };
    const sent: Message[] = [];
    let thread: string | undefined;
    const degraded = new Set<Degradation>(chunks.length > 1 ? ["text_split"] : []);
    if (found.mentions.length && !live.capabilities().mentions) degraded.add("mentions_plain");
    const report = (state: SendReport["state"]): SendReport => ({
      messages: sent,
      state,
      degraded: [...degraded],
      mentioned: found.mentioned,
      unmatched: found.unmatched,
      ...(thread ? { thread } : {}),
    });
    for (const [i, chunk] of chunks.entries()) {
      const last = i === chunks.length - 1;
      const files = last && request.files?.length ? request.files.map((path) => ({ path })) : undefined;
      const record = store.insertOutbound({
        chatId: chat.id,
        body: chunk,
        replyTo: i === 0 ? (quoted?.id ?? null) : null,
        ...(request.notice ? { notice: true } : {}),
        ...(request.lineTaskId ? { lineTaskId: request.lineTaskId } : {}),
        // Kept with the message, so the console can show what went with it.
        ...(files ? { attachments: files.map((f) => sentFile(f.path)) } : {}),
      });
      // Opening a thread or broadcasting a line's result back to the chat must go through send(),
      // not into an existing live reply card/placeholder (which cannot open a thread or broadcast).
      const opening =
        i === 0 && quoted?.platformId && request.inThread && chat.kind === "group" && live.capabilities().threads;
      // The first piece of a reply goes into the live reply opened for that message, if any.
      // Mingle's own word is not the answer the live reply waits for.
      const intoLive =
        i === 0 && quoted && chunk && !request.notice && !opening && !request.inChat
          ? await this.replies?.answer(quoted.id, chunk, found.mentions)
          : undefined;
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
        // The first piece opens the thread; the rest follow it there.
        result = await this.attempt(live, {
          chat: ref,
          text: chunk,
          ...mentions,
          ...(i === 0 && quoted?.platformId ? { replyTo: quoted.platformId } : {}),
          ...(opening ? { inThread: request.inThread } : {}),
          ...(i === 0 && quoted && request.inChat ? { inChat: true as const } : {}),
          ...(files ? { files } : {}),
        });
      }
      if (result.kind === "sent") {
        if (result.chat && result.chat !== chat.platformId) {
          store.renameChatPlatformId(chat.id, result.chat);
          ref = { ...ref, platformId: result.chat };
        }
        if (result.thread) {
          const opened = store.upsertChat({
            connectionId: chat.connectionId,
            platformId: result.thread.platformId,
            kind: "thread",
            name: result.thread.name,
            parentId: chat.kind === "thread" ? (chat.parentId ?? undefined) : chat.id,
          });
          thread = opened.id;
          ref = result.thread;
        }
        if (thread) store.setMessageChat(record.id, thread);
        store.setOutboundResult(record.id, "sent", result.platformId);
        for (const d of result.degraded ?? []) degraded.add(d);
        sent.push(store.message(record.id) as Message);
        continue;
      }
      if (result.kind === "uncertain") {
        store.setOutboundResult(record.id, "uncertain", null);
        sent.push(store.message(record.id) as Message);
        if (!request.notice) this.markAnswered(agentId, chat.id, quoted);
        return report("uncertain");
      }
      const why = result.detail ? ` (${connection.platform}: ${result.detail})` : "";
      if (result.textSent) {
        // The person has the text; only the files are missing. Say so, so nobody sends it twice.
        store.setOutboundResult(record.id, "sent", result.textSent.platformId);
        if (!request.notice) this.markAnswered(agentId, chat.id, quoted);
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
    if (!request.notice) this.markAnswered(agentId, chat.id, quoted);
    return report("sent");
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

  /**
   * A reply answers the quoted message; a plain send answers what the agent has seen in that chat.
   * Not what the harness queued behind the running turn: the model has not read it yet, and once
   * marked replied a session restart could no longer hand it back, so it would be lost.
   */
  private markAnswered(agentId: string, chatId: string, quoted: Message | undefined): void {
    const answered = quoted
      ? this.store.moveInbound([quoted.id], "reply")
      : this.store.moveInbound(
          this.store
            .chatMessages(chatId, 200)
            .filter((m) => m.direction === "in" && !this.queued(agentId, m.id))
            .map((m) => m.id),
          "send",
        );
    for (const id of answered) this.replies?.settle(id, "answered");
    // A quoted reply that skipped the live reply (e.g. to open a thread) may still have an open
    // live entry even when the message was already marked replied; settle is idempotent.
    if (quoted) this.replies?.settle(quoted.id, "answered");
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

/** Group-wide mentions that name no one person. */
const EVERYONE = new Set(["all", "everyone", "here", "channel", "所有人", "全体成员"]);

/**
 * Which `@name`s in the text are people on this bot. A name two people share goes to the one who
 * spoke in this chat; if that does not settle it, it stays plain text rather than wake the wrong one.
 * The person's name, the name given to them and the chat app's own name all count, since the agent
 * sees the first in message headers and the last where others mention them.
 */
export function resolveMentions(
  text: string,
  candidates: readonly (Contact & { spoke: boolean })[],
): { mentions: Mention[]; mentioned: { contact: string; name: string }[]; unmatched: string[] } {
  const byName = new Map<string, Map<string, Contact & { spoke: boolean }>>();
  for (const contact of candidates) {
    for (const raw of [contact.personName, contact.alias, contact.name]) {
      const name = raw?.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const holders = byName.get(key) ?? new Map();
      holders.set(contact.platformId, contact);
      byName.set(key, holders);
    }
  }
  const options: (Mention & { contact: string })[] = [];
  for (const [key, holders] of byName) {
    let who = [...holders.values()];
    if (who.length > 1) who = who.filter((c) => c.spoke);
    const one = who.length === 1 ? who[0] : undefined;
    if (!one) continue;
    const name = [one.personName, one.alias, one.name].map((n) => n?.trim()).find((n) => n?.toLowerCase() === key);
    if (name) options.push({ id: one.platformId, name, contact: one.id });
  }
  const spots = mentionSpots(text, options);
  const mentions = new Map<string, Mention>();
  const mentioned = new Map<string, { contact: string; name: string }>();
  for (const { mention } of spots) {
    const option = mention as Mention & { contact: string };
    mentions.set(`${option.id}\n${option.name}`, { id: option.id, name: option.name });
    if (!mentioned.has(option.contact)) mentioned.set(option.contact, { contact: option.contact, name: option.name });
  }
  // What else looks like a mention, so the agent knows it reached no one.
  const unmatched = new Set<string>();
  const taken = (i: number) => spots.some((s) => i >= s.start && i < s.end);
  const code = codeRanges(text);
  for (const m of text.matchAll(/(^|[^A-Za-z0-9._%+-])@([^\s@,，。、!！?？:：;；()（）[\]{}<>"'`]{1,32})/g)) {
    const at = m.index + (m[1] as string).length;
    const word = m[2] as string;
    if (taken(at) || EVERYONE.has(word.toLowerCase()) || code.some(([from, to]) => at >= from && at < to)) continue;
    unmatched.add(`@${word}`);
  }
  return {
    mentions: [...mentions.values()],
    mentioned: [...mentioned.values()],
    unmatched: [...unmatched].slice(0, 5),
  };
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

/** A file the agent sends, as kept with its message: its path, name and size. */
function sentFile(path: string): { ref: string; name: string; size?: number } {
  let size: number | undefined;
  try {
    size = statSync(path).size;
  } catch {}
  return { ref: path, name: basename(path), ...(size !== undefined ? { size } : {}) };
}
