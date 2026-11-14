import type { Platform } from "../channels/channel.ts";
import { type Chat, type Contact, contactName, type Message, type Reminder } from "../store/store.ts";

/** ISO 8601 in local time with offset, minute precision: 2026-11-11T14:02+08:00. */
export function localTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const quote = (s: string) => `"${s.replaceAll('"', "'").replaceAll("\n", " ")}"`;

/** The header line plus body an agent sees for one message. Same shape for delivery and for CLI output. */
export function formatMessage(
  message: Message,
  chat: Chat,
  platform: Platform,
  opts: { ownerId?: string | null; agentName?: string; contact?: Contact | undefined } = {},
): string {
  const parts = [`msg=${message.id}`, `chat=${chat.id}`, `im=${platform}`];
  parts.push(chat.kind === "dm" ? "dm" : `group=${quote(chat.name ?? chat.platformId)}`);
  if (message.direction === "out") {
    parts.push(`from=${quote(opts.agentName ?? "you")}`, "you");
  } else {
    // The name the agent or owner gave them, else the platform's. With neither, no `from`: a platform
    // ID is not a name, and `user=` is how the agent tells people apart and names them.
    const name = contactName(opts.contact) ?? (message.senderName !== message.senderId ? message.senderName : null);
    if (name) parts.push(`from=${quote(name)}`);
    if (opts.contact) parts.push(`user=${opts.contact.id}`);
    else if (!name) parts.push(`from=${quote(message.senderId || "unknown")}`);
    if (opts.ownerId && message.senderId === opts.ownerId) parts.push("owner");
  }
  if (message.replyTo) parts.push(`reply_to=${message.replyTo}`);
  for (const a of message.attachments) parts.push(`file=${a.id}:${quote(a.name)}`);
  parts.push(`time=${localTime(message.createdAt)}`);
  return `[${parts.join(" ")}]\n${message.body}`;
}

/** Characters of context kept on each side of a search match. */
const EXCERPT_RADIUS = 80;

/**
 * The part of `body` around the first match of `query`, for search results: enough to judge
 * whether the hit matters, not the whole message. A cut side is marked with "…", so the agent
 * knows it is reading a window, not the full text. Short bodies come back whole.
 */
export function excerpt(body: string, query: string, radius = EXCERPT_RADIUS): string {
  const chars = [...body];
  const needle = [...query];
  if (chars.length <= needle.length + 2 * radius) return body;
  const hay = body.toLowerCase();
  const at = hay.indexOf(query.toLowerCase());
  // Indexes into the string are UTF-16; turn the match position into a character position.
  const start = at < 0 ? 0 : [...body.slice(0, at)].length;
  // A window of the same width wherever the match is: near either end it slides inward.
  const width = needle.length + 2 * radius;
  const from = Math.max(0, Math.min(start - radius, chars.length - width));
  const to = Math.min(chars.length, from + width);
  return `${from > 0 ? "…" : ""}${chars.slice(from, to).join("").trim()}${to < chars.length ? "…" : ""}`;
}

export function formatReminder(reminder: Reminder, at: number): string {
  const parts = [`reminder=${reminder.id}`];
  if (reminder.chatId) parts.push(`chat=${reminder.chatId}`);
  parts.push(`time=${localTime(at)}`);
  return `[${parts.join(" ")}]\n${reminder.body}`;
}
