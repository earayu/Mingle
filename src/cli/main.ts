#!/usr/bin/env node
import { execFile } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { tailLog } from "../core/logs.ts";
import { resolvePaths } from "../core/paths.ts";
import { desktopLogFile } from "../platform/logs.ts";
import { VERSION } from "../version.ts";

/**
 * One command, two audiences:
 * - an agent inside its session (MINGLE_TOKEN set): message, chat, contact, file, task, reminder, whoami, manual;
 * - the owner in a terminal: start, status, agent, connect, disconnect, harnesses.
 */

class CliError extends Error {
  readonly code: string;
  readonly next: string;
  constructor(code: string, next: string) {
    super(code);
    this.code = code;
    this.next = next;
  }
}

const OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  file: { type: "string", multiple: true },
  to: { type: "string" },
  limit: { type: "string" },
  before: { type: "string" },
  around: { type: "string" },
  since: { type: "string" },
  in: { type: "string" },
  out: { type: "string" },
  from: { type: "string" },
  all: { type: "boolean" },
  clear: { type: "boolean" },
  status: { type: "string" },
  at: { type: "string" },
  every: { type: "string" },
  check: { type: "string" },
  once: { type: "boolean" },
  mute: { type: "boolean" },
  default: { type: "boolean" },
  for: { type: "string" },
  by: { type: "string" },
  chat: { type: "string" },
  name: { type: "string" },
  harness: { type: "string" },
  model: { type: "string" },
  role: { type: "string" },
  "role-file": { type: "string" },
  "remove-home": { type: "boolean" },
  "no-open": { type: "boolean" },
  "stop-on-stdin-close": { type: "boolean" },
  "login-shell-env": { type: "boolean" },
  port: { type: "string" },
  agent: { type: "string" },
  lines: { type: "string" },
  prompt: { type: "boolean" },
} as const;

type Flags = ReturnType<typeof parse>["values"];

function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

// ------------------------------------------------------------------- client

async function request<T>(base: string, token: string, method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new CliError("mingle_not_running", 'Mingle is not running. Start it with "mingle start"');
  }
  const type = response.headers.get("content-type") ?? "";
  const payload = type.includes("json") ? await response.json() : await response.text();
  if (!response.ok) {
    const error = payload as { error?: string; next?: string };
    throw new CliError(error.error ?? `http_${response.status}`, error.next ?? "unexpected response from Mingle");
  }
  return payload as T;
}

function agentClient() {
  const base = process.env.MINGLE_API;
  const token = process.env.MINGLE_TOKEN;
  if (!base || !token) {
    throw new CliError(
      "not_in_agent_session",
      "this command is for agents; it needs MINGLE_API and MINGLE_TOKEN, which Mingle sets in the agent's session",
    );
  }
  return <T>(method: string, path: string, body?: unknown) => request<T>(base, token, method, path, body);
}

function adminClient() {
  const paths = resolvePaths();
  if (!existsSync(paths.runtime)) {
    throw new CliError("mingle_not_running", 'Mingle is not running. Start it with "mingle start"');
  }
  const runtime = JSON.parse(readFileSync(paths.runtime, "utf8")) as { url: string; adminToken: string };
  return <T>(method: string, path: string, body?: unknown) =>
    request<T>(runtime.url, runtime.adminToken, method, path, body);
}

/** How often a group that hears everything reaches the agent (docs/spec.md 4.2). */
interface Hearing {
  pace: "auto" | "every" | "muted";
  everyMs?: number;
  slowedMs?: number;
  tier?: "save" | "balanced" | "fast" | null;
  defaultTier?: "save" | "balanced" | "fast";
  aliases?: string[];
}

function hearingText(h: Hearing): string {
  if (h.pace === "muted")
    return "you hear nothing said here until someone @-mentions you or replies to you; then the usual pace is back";
  if (h.pace === "every")
    return `you hear what was said here at most once every ${minutes(h.everyMs ?? 0)}, until you change it`;
  if (h.slowedMs)
    return `the usual pace, slowed to once every ${minutes(h.slowedMs)} because you left the last stretches unanswered`;
  return "the usual pace: soon after people pause, at most every few minutes";
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 ? `${m / 60}h` : `${m}m`;
}

interface ContactRow {
  id: string;
  platform: string;
  name: string | null;
  platformName: string | null;
  owner: boolean;
  bot: boolean;
  person: string | null;
  profile: string | null;
}

interface ContactInfo {
  person: { id: string; name: string | null; note: string | null } | null;
  accounts: {
    id: string;
    platform: string;
    name: string | null;
    platformName: string | null;
    owner: boolean;
    bot: boolean;
    linkedBy: "owner" | "agent" | null;
    profile: string | null;
    chats: { id: string; kind: string; name: string | null }[];
  }[];
}

const marks = (k: { owner: boolean; bot: boolean }) => `${k.owner ? "  owner" : ""}${k.bot ? "  bot" : ""}`;
/** Department and title, where the chat app gives them. */
const where = (k: { profile?: string | null }) => (k.profile ? `  ${JSON.stringify(k.profile)}` : "");

/** One line per account; accounts of one person under the person's line. */
function contactList(contacts: readonly ContactRow[]): string {
  const line = (k: ContactRow, indent: string) => {
    const given = k.name && k.name !== k.platformName && k.platformName ? `  (${k.platformName} on ${k.platform})` : "";
    return `${indent}${k.id}  ${k.platform}  ${k.name ? JSON.stringify(k.name) : "no name"}${given}${where(k)}${marks(k)}`;
  };
  const out: string[] = [];
  const done = new Set<string>();
  for (const k of contacts) {
    if (!k.person) {
      out.push(line(k, ""));
      continue;
    }
    if (done.has(k.person)) continue;
    done.add(k.person);
    const members = contacts.filter((m) => m.person === k.person);
    out.push(
      `${k.person}  ${k.name ? JSON.stringify(k.name) : "no name"}  ${members.length} account${members.length > 1 ? "s" : ""}`,
    );
    for (const m of members) out.push(line({ ...m, name: m.platformName }, "  "));
  }
  return out.join("\n");
}

function contactInfo(found: ContactInfo): string {
  const out: string[] = [];
  const name = found.person?.name ?? found.accounts[0]?.name;
  out.push(`${found.person ? `${found.person.id}  ` : ""}${name ? JSON.stringify(name) : "no name"}`);
  for (const k of found.accounts) {
    const by = k.linkedBy === "owner" ? "  linked by your owner" : k.linkedBy === "agent" ? "  linked by you" : "";
    out.push(
      `  ${k.id}  ${k.platform}  ${k.platformName ? JSON.stringify(k.platformName) : "no name"}${where(k)}${marks(k)}${by}`,
    );
    const dm = k.chats.find((c) => c.kind === "dm");
    if (dm) out.push(`    direct chat: ${dm.id}`);
    const groups = k.chats.filter((c) => c.kind !== "dm");
    if (groups.length) {
      out.push(`    also in: ${groups.map((c) => (c.name ? `${c.id} ${JSON.stringify(c.name)}` : c.id)).join(", ")}`);
    }
    if (!dm && !groups.length) out.push("    no chat yet");
  }
  out.push(found.person?.note ? `note:\n${found.person.note}` : "no note");
  return out.join("\n");
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function need(value: string | undefined, code: string, next: string): string {
  if (!value) throw new CliError(code, next);
  return value;
}

// ------------------------------------------------------------------ output

let jsonMode = false;

function print(data: unknown, text: () => string): void {
  console.log(jsonMode ? JSON.stringify(data, null, 2) : text());
}

function kilobytes(bytes: number): string {
  return `${Math.max(0.1, Math.round(bytes / 102.4) / 10)} KB`;
}

function time(ms: number | null): string {
  if (ms === null) return "-";
  const d = new Date(ms);
  return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

interface SendReport {
  messages: { id: string }[];
  state: "sent" | "uncertain";
  degraded: string[];
  mentioned?: { contact: string; name: string }[];
  unmatched?: string[];
}

function sendText(report: SendReport): string {
  const ids = report.messages.map((m) => m.id).join(", ");
  const lines = [
    report.state === "sent"
      ? `sent ${ids}`
      : `uncertain ${ids}: the chat app did not confirm; check with "mingle message read" before resending`,
  ];
  const notes: Record<string, string> = {
    quote_dropped: "this chat app does not support quoting; sent as a plain message",
    files_dropped: "files were not sent",
    markdown_flattened: "formatting is shown as plain text here",
    text_split: "the text was long and went out as several messages",
    mentions_plain: "this chat app has no mentions a bot can make; the names went out as plain text and notify no one",
  };
  if (report.mentioned?.length)
    lines.push(`mentioned ${report.mentioned.map((m) => `@${m.name} (${m.contact})`).join(", ")}`);
  for (const d of report.degraded) if (notes[d]) lines.push(`note: ${notes[d]}`);
  if (report.unmatched?.length)
    lines.push(
      `note: ${report.unmatched.join(", ")} matched no one in this chat and went out as plain text, so nobody was notified. ` +
        `To mention someone, write @ and their name exactly as "mingle contact list" shows it`,
    );
  return lines.join("\n");
}

// ---------------------------------------------------------------- commands

async function agentCommand(group: string, action: string | undefined, args: string[], flags: Flags): Promise<boolean> {
  const call = () => agentClient();
  const files = (flags.file ?? []).map((f) => resolve(f));
  switch (`${group} ${action ?? ""}`.trim()) {
    case "message reply": {
      const id = need(args[0], "message_id_required", "usage: mingle message reply <message-id> <<'MSG' ... MSG");
      const text = await readStdin();
      const report = await call()<SendReport>("POST", "/v1/agent/messages/reply", { messageId: id, text, files });
      print(report, () => sendText(report));
      return true;
    }
    case "message send": {
      // A line may leave --to out: it sends about its task, where that is (docs/spec.md 4.13).
      const to = flags.to;
      const text = await readStdin();
      const report = await call()<SendReport>("POST", "/v1/agent/messages/send", { to, text, files });
      print(report, () => sendText(report));
      return true;
    }
    case "message read": {
      const chat = need(
        args[0],
        "chat_required",
        "usage: mingle message read <chat-id> [--limit 30] [--before <message-id> | --since <message-id> | --around <message-id>]",
      );
      const anchors = (["before", "since", "around"] as const).filter((k) => flags[k]);
      if (anchors.length > 1) throw new CliError("flags_conflict", "pass only one of --before, --since and --around");
      const q = new URLSearchParams({
        limit: flags.limit ?? (flags.around ? "11" : "30"),
        ...(flags.around
          ? { around: flags.around }
          : flags.since
            ? { since: flags.since }
            : flags.before
              ? { before: flags.before }
              : {}),
      });
      const messages = await call()<{ id: string; text: string }[]>("GET", `/v1/agent/chats/${chat}/messages?${q}`);
      print(messages, () => messages.map((m) => m.text).join("\n\n") || "no messages");
      return true;
    }
    case "message search": {
      const query = need(args.join(" "), "query_required", 'usage: mingle message search "words" [--in <chat-id>]');
      const q = new URLSearchParams({
        q: query,
        ...(flags.in ? { in: flags.in } : {}),
        ...(flags.limit ? { limit: flags.limit } : {}),
      });
      const messages = await call()<{ id: string; chat: string; text: string }[]>(
        "GET",
        `/v1/agent/messages/search?${q}`,
      );
      // Each hit is a window around the match; the closing lines say whether that was all of them
      // and how to open one (docs/spec.md 5.3).
      const first = messages[0];
      const limit = Math.min(100, Math.max(1, Number(flags.limit ?? 20) || 20));
      const more =
        messages.length >= limit
          ? `\nThese are only the newest ${limit}; older matches may exist. Add words, narrow with --in <chat-id>, or raise --limit (up to 100).`
          : "";
      print(messages, () =>
        first
          ? `${messages.map((m) => m.text).join("\n\n")}\n\n${messages.length} match${messages.length === 1 ? "" : "es"} containing every word, newest first. <match> marks the hit, "…" marks cut text.${more}\nRead around one before relying on it: "$MINGLE_CLI" message read ${first.chat} --around ${first.id}`
          : "no matches: no message you have seen contains every one of these words. Try fewer or other words, or the language the chat uses.",
      );
      return true;
    }
    case "chat list": {
      const chats = await call()<
        { id: string; platform: string; kind: string; name: string | null; lastAt: number | null }[]
      >("GET", "/v1/agent/chats");
      print(chats, () =>
        chats.length
          ? chats.map((c) => `${c.id}  ${c.platform}  ${c.kind}  ${c.name ?? "-"}  last ${time(c.lastAt)}`).join("\n")
          : "no chats yet: nobody has messaged you",
      );
      return true;
    }
    case "chat info": {
      const chat = need(args[0], "chat_required", "usage: mingle chat info <chat-id>");
      const info = await call()<{
        id: string;
        platform: string;
        kind: string;
        name: string | null;
        members: { id: string; name: string; profile: string | null; bot: boolean }[] | null;
        hearing: Hearing | null;
      }>("GET", `/v1/agent/chats/${chat}`);
      print(info, () =>
        [
          `${info.id}  ${info.platform}  ${info.kind}  ${info.name ?? "-"}`,
          ...(info.hearing
            ? [
                `hears everything: ${hearingText(info.hearing)}`,
                `keeps up with a conversation: ${info.hearing.tier ?? `${info.hearing.defaultTier ?? "fast"}, by the group's size`} (your owner's choice)`,
                `also called here: ${info.hearing.aliases?.length ? info.hearing.aliases.join(", ") : "none"}`,
              ]
            : []),
          info.members
            ? [
                "members:",
                ...info.members.map(
                  (m) => `  ${m.id}  ${m.name ? JSON.stringify(m.name) : "no name"}${where(m)}${m.bot ? "  bot" : ""}`,
                ),
              ].join("\n")
            : "members: not available on this chat app",
        ].join("\n"),
      );
      return true;
    }
    case "chat hear": {
      const usage = "usage: mingle chat hear <chat-id> --every 1h | --mute | --default";
      const chat = need(args[0], "chat_required", usage);
      const given = [flags.every !== undefined, flags.mute, flags.default].filter(Boolean).length;
      if (given !== 1)
        throw new CliError("flags_conflict", `pass exactly one of --every, --mute and --default; ${usage}`);
      const hearing = await call()<Hearing & { chat: string }>("PUT", `/v1/agent/chats/${chat}/hearing`, {
        ...(flags.every !== undefined ? { every: flags.every } : flags.mute ? { mute: true } : { default: true }),
      });
      print(hearing, () => `${hearing.chat}: ${hearingText(hearing)}`);
      return true;
    }
    case "chat alias": {
      const usage = "usage: mingle chat alias <chat-id> add|remove <name>";
      const chat = need(args[0], "chat_required", usage);
      const action = args[1];
      const name = args.slice(2).join(" ").trim();
      if ((action !== "add" && action !== "remove") || !name) throw new CliError("alias_invalid", usage);
      const result = await call()<{ chat: string; aliases: string[] }>(
        action === "add" ? "POST" : "DELETE",
        `/v1/agent/chats/${chat}/aliases`,
        { alias: name },
      );
      print(
        result,
        () =>
          `${result.chat}: ${result.aliases.length ? `also called ${result.aliases.join(", ")}` : "no other names"}`,
      );
      return true;
    }
    case "contact list": {
      const query = args.join(" ").trim();
      const contacts = await call()<ContactRow[]>(
        "GET",
        `/v1/agent/contacts${query ? `?${new URLSearchParams({ q: query })}` : ""}`,
      );
      print(contacts, () =>
        contacts.length
          ? contactList(contacts)
          : query
            ? `no contact named like "${query}". Try part of the name, or "mingle chat info <chat>" for a group's members. ` +
              "You can reach only people in your chats; if they are not, tell whoever asked"
            : "no contacts yet: nobody has messaged you",
      );
      return true;
    }
    case "contact info": {
      const id = need(args[0], "contact_required", "usage: mingle contact info <user-or-person-id>");
      const found = await call()<ContactInfo>("GET", `/v1/agent/contacts/${id}`);
      print(found, () => contactInfo(found));
      return true;
    }
    case "contact name": {
      const usage = 'usage: mingle contact name <user-or-person-id> "name" | mingle contact name <id> --clear';
      const id = need(args[0], "contact_required", usage);
      const name = flags.clear ? null : need(args.slice(1).join(" ").trim(), "name_required", usage);
      const contact = await call()<{ id: string; name: string | null }>("PATCH", `/v1/agent/contacts/${id}`, { name });
      print(contact, () =>
        contact.name ? `${contact.id} is now ${JSON.stringify(contact.name)}` : `${contact.id} has no name now`,
      );
      return true;
    }
    case "contact link": {
      const usage = "usage: mingle contact link <user-id> <user-id>";
      const ids = [need(args[0], "contacts_required", usage), need(args[1], "contacts_required", usage)];
      const found = await call()<ContactInfo>("POST", "/v1/agent/contacts/link", { ids });
      print(found, () => `linked as ${found.person?.id}\n${contactInfo(found)}`);
      return true;
    }
    case "contact unlink": {
      const id = need(args[0], "contact_required", "usage: mingle contact unlink <user-id>");
      const result = await call()<{ ok: true }>("POST", `/v1/agent/contacts/${id}/unlink`);
      print(result, () => `${id} is on its own again`);
      return true;
    }
    case "contact note": {
      const usage =
        "usage: mingle contact note <user-or-person-id> <<'NOTE' ... NOTE | mingle contact note <id> --clear";
      const id = need(args[0], "contact_required", usage);
      const note = flags.clear ? null : need((await readStdin()).trim(), "note_required", usage);
      const result = await call()<{ person: string | null; note: string | null }>(
        "PUT",
        `/v1/agent/contacts/${id}/note`,
        { note },
      );
      print(result, () => (result.note ? `saved the note on ${result.person}` : `${id} has no note now`));
      return true;
    }
    case "file get": {
      const id = need(args[0], "file_id_required", "usage: mingle file get <file-id> [--out <path>]");
      const result = await call()<{ path: string; name: string }>("POST", `/v1/agent/files/${id}/download`, {
        ...(flags.out ? { to: resolve(flags.out) } : { dir: process.cwd() }),
      });
      print(result, () => `saved ${result.name} to ${result.path}`);
      return true;
    }
    case "task create": {
      const title = need(args.join(" "), "title_required", 'usage: mingle task create "title" [--from <message-id>]');
      const task = await call()<{ id: string; title: string }>("POST", "/v1/agent/tasks", { title, from: flags.from });
      print(task, () => `created ${task.id}: ${task.title}`);
      return true;
    }
    case "task list": {
      const tasks = await call()<{ id: string; title: string; status: string; fromChat: string | null }[]>(
        "GET",
        `/v1/agent/tasks${flags.all ? "?all=1" : ""}`,
      );
      print(tasks, () =>
        tasks.length
          ? tasks.map((t) => `${t.id}  ${t.status}  ${t.title}${t.fromChat ? `  (from ${t.fromChat})` : ""}`).join("\n")
          : "no open tasks",
      );
      return true;
    }
    case "task run": {
      const usage = 'usage: mingle task run "title" --from <message-id>, the brief on standard input';
      const title = need(args.join(" "), "title_required", usage);
      const from = need(flags.from, "from_required", usage);
      const brief = need((await readStdin()).trim(), "brief_required", usage);
      const task = await call()<{ id: string; title: string; lineState: string; thread?: string }>(
        "POST",
        "/v1/agent/tasks/run",
        { title, from, brief },
      );
      // Where people follow the work: a thread under the message where the chat app has them.
      const where =
        task.thread === "opens"
          ? `\nYour acknowledgement (message reply ${from}) opens a thread under it: the work goes on there, the result comes back to the chat.`
          : task.thread === "existing"
            ? "\nThe work goes on in the thread the message is in."
            : "";
      print(task, () =>
        task.lineState === "queued"
          ? `started ${task.id}: ${task.title} (waiting for a free line; it starts by itself)${where}`
          : `started ${task.id}: ${task.title}; it answers under ${from} itself${where}`,
      );
      return true;
    }
    case "task tell": {
      const id = need(
        args[0],
        "task_id_required",
        "usage: mingle task tell <task-id> [--from <message-id>] [note on standard input]",
      );
      const note = (await readStdin()).trim();
      const task = await call()<{ id: string; title: string }>("POST", `/v1/agent/tasks/${id}/tell`, {
        ...(note ? { text: note } : {}),
        ...(flags.from ? { from: flags.from } : {}),
      });
      print(task, () => `passed on to ${task.id} (${task.title})`);
      return true;
    }
    case "task done": {
      const id = need(args[0], "task_id_required", "usage: mingle task done <task-id>, the summary on standard input");
      const summary = need((await readStdin()).trim(), "summary_required", "pass a summary on standard input");
      const task = await call()<{ id: string; title: string }>("POST", `/v1/agent/tasks/${id}/done`, { summary });
      print(task, () => `${task.id} is done; your main session gets the summary`);
      return true;
    }
    case "task status": {
      const text = need(
        args.join(" ").trim(),
        "text_required",
        'usage: mingle task status "Found the cause; fixing it"',
      );
      const task = await call()<{ id: string; progress: string | null }>("POST", "/v1/agent/tasks/progress", { text });
      print(task, () => `${task.id}: ${task.progress ?? ""}`);
      return true;
    }
    case "task update": {
      const id = need(args[0], "task_id_required", "usage: mingle task update <task-id> --status done");
      const status = need(flags.status, "status_required", "pass --status todo|in_progress|done|closed");
      const task = await call()<{ id: string; status: string }>("PATCH", `/v1/agent/tasks/${id}`, { status });
      print(task, () => `${task.id} is now ${task.status}`);
      return true;
    }
    case "reminder set": {
      const text = need(
        args.join(" "),
        "text_required",
        'usage: mingle reminder set "text" --in 6h | --at <time> | --every daily@09:00 [--check <command> [--once] [--for 7d|forever]]',
      );
      const reminder = await call()<{
        id: string;
        nextFireAt: number;
        check: { until: number | null } | null;
        /** The first run's output, sent back this once; only its hash is kept. */
        checkOutput?: string | null;
      }>("POST", "/v1/agent/reminders", {
        text,
        in: flags.in,
        at: flags.at,
        every: flags.every,
        chat: flags.chat,
        from: flags.from,
        check: flags.check,
        once: flags.once,
        for: flags.for,
      });
      print(reminder, () =>
        reminder.check
          ? `set ${reminder.id}, next check at ${time(reminder.nextFireAt)}, checking ${reminder.check.until === null ? "forever" : `until ${time(reminder.check.until)}`}; it fires when the output changes from:\n${reminder.checkOutput || "(empty)"}`
          : `set ${reminder.id}, next at ${time(reminder.nextFireAt)}`,
      );
      return true;
    }
    case "reminder list": {
      const reminders = await call()<
        {
          id: string;
          body: string;
          rule: string;
          nextFireAt: number;
          sourceMessageId: string | null;
          check: {
            command: string;
            once: boolean;
            failures: number;
            error: string | null;
            until: number | null;
          } | null;
        }[]
      >("GET", "/v1/agent/reminders");
      const checkLine = (c: NonNullable<(typeof reminders)[number]["check"]>) =>
        `\n    check${c.once ? " (once)" : ""} ${c.until === null ? "forever" : `until ${time(c.until)}`}: ${c.command}${c.failures ? `\n    failing ${c.failures}x: ${c.error}` : ""}`;
      print(reminders, () =>
        reminders.length
          ? reminders
              .map(
                (r) =>
                  `${r.id}  ${time(r.nextFireAt)}  ${r.rule}  ${r.body}${r.sourceMessageId ? `  (from ${r.sourceMessageId})` : ""}${r.check ? checkLine(r.check) : ""}`,
              )
              .join("\n")
          : "no reminders",
      );
      return true;
    }
    case "reminder snooze": {
      const id = need(args[0], "reminder_id_required", "usage: mingle reminder snooze <reminder-id> --by 2h");
      const by = need(flags.by, "duration_required", "pass --by with a duration, like --by 2h");
      const reminder = await call()<{ id: string; rule: string; nextFireAt: number }>(
        "POST",
        `/v1/agent/reminders/${id}/snooze`,
        { by },
      );
      print(reminder, () =>
        reminder.rule === "once"
          ? `${reminder.id} snoozed, next at ${time(reminder.nextFireAt)}`
          : `${reminder.id} snoozed, next at ${time(reminder.nextFireAt)}, then ${reminder.rule} again`,
      );
      return true;
    }
    case "reminder cancel": {
      const id = need(args[0], "reminder_id_required", "usage: mingle reminder cancel <reminder-id>");
      const result = await call()<unknown>("DELETE", `/v1/agent/reminders/${id}`);
      print(result, () => `cancelled ${id}`);
      return true;
    }
    case "whoami": {
      const me = await call()<{
        name: string;
        harness: string;
        home: string;
        connections: { platform: string; bot: string; state: string }[];
        line?: string;
        doing: { id: string; title: string; status: string; line: string | null; from: string | null }[];
      }>("GET", "/v1/agent/whoami");
      const doing = me.doing.map(
        (t) => `  ${t.id}  ${t.line === "idle" ? t.status : t.line}  ${t.title}  (from ${t.from})`,
      );
      print(me, () =>
        [
          `${me.name} (${me.harness})`,
          `home: ${me.home}`,
          ...me.connections.map((c) => `${c.platform}: ${c.bot} ${c.state}`),
          ...(me.line
            ? ["", `this session works on ${me.line}`, ...doing]
            : doing.length
              ? ["", "doing:", ...doing]
              : []),
        ].join("\n"),
      );
      return true;
    }
    case "manual": {
      console.log(await call()<string>("GET", "/v1/agent/manual"));
      return true;
    }
  }
  return false;
}

async function adminCommand(group: string, action: string | undefined, args: string[], flags: Flags): Promise<boolean> {
  // These two take a value, not a subcommand, as their first argument.
  if (group === "connect") {
    // mingle connect <agent> telegram   (bot token on standard input)
    const agent = need(action, "agent_required", "usage: echo $BOT_TOKEN | mingle connect <agent> telegram");
    const platform = args[0] ?? "telegram";
    if (platform !== "telegram") {
      throw new CliError("platform_unsupported", "only telegram can be connected from the command line for now");
    }
    const token = need(
      (await readStdin()).trim(),
      "token_required",
      "pass the bot token from @BotFather on standard input",
    );
    const connection = await adminClient()<{ id: string; bot: string; state: string }>(
      "POST",
      `/v1/admin/agents/${agent}/connections`,
      { platform, credentials: { token } },
    );
    print(
      connection,
      () =>
        `connected ${connection.bot} (${connection.id}). Send it a direct message from your own account to become its owner.`,
    );
    return true;
  }
  if (group === "handoff") {
    // mingle handoff prompt <agent>   |   mingle handoff <agent>   (the handoff on standard input)
    if (action === "prompt" && args[0]) {
      const result = await adminClient()<{ text: string }>("GET", `/v1/admin/agents/${args[0]}/handoff-prompt`);
      print(result, () => result.text.trimEnd());
      return true;
    }
    const agent = need(action, "agent_required", "usage: mingle handoff <agent> <<'HANDOFF' ... HANDOFF");
    // An agent's own session speaks as that agent; it does not hand another one work as the owner.
    if (process.env.MINGLE_TOKEN) {
      throw new CliError("handoff_from_agent", "a handoff comes from the owner's own conversation, not from an agent");
    }
    const body = await readStdin();
    if (!body.trim()) {
      throw new CliError("handoff_empty", "write the handoff and pass it on standard input, e.g. with a heredoc");
    }
    const result = await adminClient()<{
      handoff: { id: string; size: number };
      name: string;
      state: "idle" | "busy" | "paused";
    }>("POST", `/v1/admin/agents/${agent}/handoffs`, { body, via: "command" });
    const when = {
      idle: `${result.name} reads it now`,
      busy: `${result.name} is working; it reads this when it finishes`,
      paused: `${result.name} is paused; it reads this when resumed`,
    }[result.state];
    print(
      result,
      () => `Handed off to ${result.name} (${result.handoff.id}, ${kilobytes(result.handoff.size)}). ${when}.`,
    );
    return true;
  }
  if (group === "disconnect") {
    const id = need(action, "connection_required", "usage: mingle disconnect <connection-id>");
    await adminClient()("DELETE", `/v1/admin/connections/${id}`);
    print({ ok: true }, () => "disconnected");
    return true;
  }
  switch (`${group} ${action ?? ""}`.trim()) {
    case "status": {
      const status = await adminClient()<{ version: string; agents: AgentView[] }>("GET", "/v1/admin/status");
      print(status, () =>
        status.agents.length
          ? status.agents.map(agentLine).join("\n")
          : 'no agents yet. Create one with "mingle agent create --name Alex --harness claude"',
      );
      return true;
    }
    case "harnesses": {
      const list = await adminClient()<{ id: string; name: string; version?: string }[]>("GET", "/v1/admin/harnesses");
      print(
        list,
        () =>
          list.map((h) => `${h.id}  ${h.name}  ${h.version ?? ""}`).join("\n") ||
          "no supported harness found on this computer",
      );
      return true;
    }
    case "agent create": {
      const name = need(
        flags.name,
        "name_required",
        "usage: mingle agent create --name Alex --harness claude [--role ...|--role-file path]",
      );
      const harness = need(
        flags.harness,
        "harness_required",
        'pass --harness; "mingle harnesses" lists what is installed',
      );
      const role = flags["role-file"] ? readFileSync(flags["role-file"], "utf8") : (flags.role ?? "");
      const agent = await adminClient()<AgentView>("POST", "/v1/admin/agents", {
        name,
        harness,
        model: flags.model,
        role,
      });
      print(agent, () => `created ${agent.name} (${agent.slug}), home ${agent.home}`);
      return true;
    }
    case "agent list": {
      const status = await adminClient()<{ agents: AgentView[] }>("GET", "/v1/admin/status");
      print(status.agents, () => status.agents.map(agentLine).join("\n") || "no agents");
      return true;
    }
    case "agent role": {
      const id = need(args[0], "agent_required", "usage: mingle agent role <agent> <<'ROLE' ... ROLE");
      const role = flags["role-file"] ? readFileSync(flags["role-file"], "utf8") : await readStdin();
      await adminClient()("PUT", `/v1/admin/agents/${id}/role`, { role });
      print({ ok: true }, () => "role updated; it applies from the next message");
      return true;
    }
    case "agent stop": {
      const id = need(args[0], "agent_required", "usage: mingle agent stop <agent>");
      const result = await adminClient()<{ stopped: boolean }>("POST", `/v1/admin/agents/${id}/stop`);
      print(result, () => (result.stopped ? "stopped" : "it was not working on anything"));
      return true;
    }
    case "agent pause":
    case "agent resume": {
      const verb = action === "pause" ? "pause" : "resume";
      const id = need(args[0], "agent_required", `usage: mingle agent ${verb} <agent>`);
      const result = await adminClient()<{ changed: boolean }>("POST", `/v1/admin/agents/${id}/${verb}`);
      print(result, () =>
        verb === "pause"
          ? result.changed
            ? "paused; it takes no messages until you resume it"
            : "it was already paused"
          : result.changed
            ? "resumed"
            : "it was not paused",
      );
      return true;
    }
    case "agent reset": {
      const id = need(args[0], "agent_required", "usage: mingle agent reset <agent>");
      await adminClient()("POST", `/v1/admin/agents/${id}/reset`);
      print({ ok: true }, () => "reset; it starts a new session from ROLE.md and MEMORY.md");
      return true;
    }
    case "agent diagnostics": {
      const id = need(args[0], "agent_required", "usage: mingle agent diagnostics <agent> [--prompt]");
      const path = `/v1/admin/agents/${id}/${flags.prompt ? "diagnosis-prompt" : "diagnostics"}`;
      const result = await adminClient()<{ text: string }>("GET", path);
      print(result, () => result.text.trimEnd());
      return true;
    }
    case "log":
      await showLog(flags);
      return true;
    case "agent delete": {
      const id = need(args[0], "agent_required", "usage: mingle agent delete <agent> [--remove-home]");
      await adminClient()("DELETE", `/v1/admin/agents/${id}${flags["remove-home"] ? "?removeHome=1" : ""}`);
      print({ ok: true }, () =>
        flags["remove-home"] ? "deleted, including its home directory" : "deleted; its home directory was kept",
      );
      return true;
    }
    case "start":
      await start(flags);
      return true;
    case "open": {
      const paths = resolvePaths();
      if (!existsSync(paths.runtime)) {
        throw new CliError("mingle_not_running", 'Mingle is not running. Start it with "mingle start"');
      }
      const runtime = JSON.parse(readFileSync(paths.runtime, "utf8")) as { url: string; adminToken: string };
      const url = consoleUrl(runtime.url, runtime.adminToken);
      openUrl(url);
      print({ url }, () => url);
      return true;
    }
  }
  return false;
}

interface AgentView {
  id: string;
  slug: string;
  name: string;
  harness: string;
  status: string;
  statusDetail: string | null;
  home: string;
  connections: { id: string; platform: string; bot: string | null; state: string; owner: boolean }[];
}

function agentLine(a: AgentView): string {
  const conns = a.connections.map(
    (c) => `${c.platform}:${c.bot ?? "?"} ${c.state}${c.owner ? "" : " (no owner yet)"} [${c.id}]`,
  );
  return [
    `${a.name} (${a.slug})  ${a.harness}  ${a.status}${a.statusDetail ? `: ${a.statusDetail}` : ""}`,
    ...conns.map((c) => `  ${c}`),
  ].join("\n");
}

// --------------------------------------------------------------------- log

/**
 * The tail of Mingle's log, and of the desktop app's log of Mingle's error output (crash traces).
 * Reads the files directly, so it works when Mingle is not running, which is when it matters most.
 */
async function showLog(flags: Flags): Promise<void> {
  const count = Number(flags.lines ?? 200);
  if (!Number.isInteger(count) || count < 1) {
    throw new CliError("invalid_lines", "--lines takes a whole number of lines, e.g. --lines 300");
  }
  const terms = flags.agent ? await agentTerms(flags.agent) : [];
  const file = resolve(resolvePaths().logs, "mingle.log");
  const lines = tailLog(file, count, terms) ?? [];
  const desktopFile = desktopLogFile();
  // Crash traces do not name the agent; show them unfiltered.
  const desktop = tailLog(desktopFile, count);
  const about = flags.agent ? ` mentioning ${terms.join(", ")}` : "";
  print({ file, lines, desktop: desktop?.length ? { file: desktopFile, lines: desktop } : null }, () =>
    [
      `# ${file}: last ${lines.length} lines${about}`,
      ...(lines.length ? lines : ["(nothing)"]),
      ...(desktop?.length
        ? ["", `# ${desktopFile} (desktop app, Mingle's error output): last ${desktop.length} lines`, ...desktop]
        : []),
    ].join("\n"),
  );
}

/**
 * What the log calls an agent: its ID, name and slug, and its connections' IDs. Without a running
 * Mingle to ask, the given text alone.
 */
async function agentTerms(agent: string): Promise<string[]> {
  try {
    const status = await adminClient()<{ agents: AgentView[] }>("GET", "/v1/admin/status");
    const found = status.agents.find((a) => a.id === agent || a.slug === agent || a.name === agent);
    if (found) return [...new Set([found.id, found.name, found.slug, ...found.connections.map((c) => c.id)])];
  } catch {}
  return [agent];
}

// ------------------------------------------------------------------- start

async function start(flags: Flags): Promise<void> {
  const paths = resolvePaths();
  if (existsSync(paths.runtime)) {
    const runtime = JSON.parse(readFileSync(paths.runtime, "utf8")) as { url: string; pid: number };
    const alive = await fetch(`${runtime.url}/v1/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (alive)
      throw new CliError("already_running", `Mingle is already running at ${runtime.url} (pid ${runtime.pid})`);
  }
  const logFile = resolve(paths.logs, "mingle.log");
  const log = (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    console.log(stamped);
    try {
      appendFileSync(logFile, `${stamped}\n`);
    } catch {}
  };
  // Loaded here so agent commands, which run often, do not pay for OAR and the server.
  const [{ createApi, listen, serveConsole }, { loadChannels }, { Mingle }, harnessModule, { defaultSecrets }] =
    await Promise.all([
      import("../api/server.ts"),
      import("../channels/registry.ts"),
      import("../core/mingle.ts"),
      import("../harness/harness.ts"),
      import("../platform/secrets.ts"),
    ]);
  // The desktop app starts us with the bare environment the system gives apps. Take the
  // user's login-shell environment, so harness setup in ~/.zshrc (API keys, base URLs,
  // proxies, PATH) works the same as in a terminal.
  if (flags["login-shell-env"]) await adoptLoginShellEnvironment(harnessModule.loginShellEnvironment, log);
  const { oarHarness } = harnessModule;
  const mingle = new Mingle({
    paths,
    // Harness SDKs Mingle does not ship (Cursor's) are installed here on request.
    harness: oarHarness(undefined, { vendorDir: resolve(paths.home, "vendor") }),
    channels: await loadChannels(),
    secrets: defaultSecrets(resolve(paths.home, "secrets.json")),
    cliEntry: fileURLToPath(import.meta.url),
    ...(process.env.MINGLE_COLD_START ? { coldStart: process.env.MINGLE_COLD_START } : {}),
    log,
  });
  const app = createApi(mingle);
  const hasConsole = serveConsole(app);
  const port = Number(flags.port ?? process.env.MINGLE_PORT ?? 7419);
  const server = await listen(app, port).catch(() => listen(app, 0));
  await mingle.start(server.url);
  writeFileSync(paths.runtime, JSON.stringify({ url: server.url, adminToken: mingle.adminToken, pid: process.pid }), {
    mode: 0o600,
  });
  // `mode` only applies when the file is created; a leftover from a crash keeps its old permissions.
  chmodSync(paths.runtime, 0o600);
  log(`Mingle ${VERSION} listening on ${server.url}, data in ${paths.home}`);
  if (hasConsole) {
    const url = consoleUrl(server.url, mingle.adminToken);
    // The URL carries the admin token: show it on screen, keep it out of the log file.
    console.log(`console: ${url}`);
    if (!flags["no-open"]) openUrl(url);
  } else {
    log('console not built; run "pnpm build" to include it');
  }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log("stopping");
    rmSync(paths.runtime, { force: true });
    // Never hang on the way out: whoever sent the signal is waiting.
    setTimeout(() => process.exit(0), 10_000).unref();
    // Running check commands start dying now, not after the server has drained.
    mingle.beginShutdown();
    // Stop taking requests before the store closes under them.
    await server.close();
    await mingle.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // The desktop app holds our stdin open and closes it to stop us. Windows has no
  // SIGTERM, and this also stops Mingle when the app itself dies.
  if (flags["stop-on-stdin-close"]) {
    process.stdin.on("end", shutdown).on("close", shutdown).on("error", shutdown);
    process.stdin.resume();
  }
}

async function adoptLoginShellEnvironment(
  read: () => Promise<{ readonly env: Readonly<Record<string, string | null>> } | { readonly failed: string }>,
  log: (line: string) => void,
): Promise<void> {
  const { applyShellEnvironment, nodeDir } = await import("../platform/shell-env.ts");
  const shell = await read();
  if ("failed" in shell) {
    // Windows apps already get the user's environment; elsewhere, say why and carry on.
    if (shell.failed !== "unsupported_platform") log(`could not read the login shell environment (${shell.failed})`);
    applyShellEnvironment(process.env, {}, nodeDir());
    return;
  }
  const changed = applyShellEnvironment(process.env, shell.env, nodeDir());
  log(`took ${changed.length} variables from the login shell`);
}

/** The admin token travels in the fragment, which browsers never send to the server or in Referer headers. */
function consoleUrl(base: string, token: string): string {
  return `${base}/#token=${token}`;
}

function openUrl(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(opener, [url], () => {});
}

// -------------------------------------------------------------------- help

const HELP = `mingle ${VERSION}

For the owner:
  mingle start [--port 7419] [--no-open]   run Mingle in this terminal and open the console
  mingle open                              open the console of the running Mingle
  mingle status                            agents and their connections
  mingle harnesses                         harnesses installed on this computer
  mingle agent create --name <n> --harness <id> [--model <m>] [--role <text> | --role-file <path>]
  mingle agent role <agent>                replace ROLE.md from standard input
  mingle agent stop <agent>                stop what it is doing now
  mingle agent pause <agent>               stop it and take no messages until resumed
  mingle agent resume <agent>              take messages again
  mingle agent reset <agent>               start it over in a new session; memory and files stay
  mingle agent diagnostics <agent> [--prompt]
                                           versions, brain, session and status; --prompt wraps them in a
                                           prompt for a local agent to find the cause and file a GitHub issue
  mingle log [--agent <agent>] [--lines 200]
                                           the end of Mingle's log, optionally only what mentions an agent
  mingle agent delete <agent> [--remove-home]
  mingle handoff <agent>                   hand it what another conversation knows, on standard input
  mingle handoff prompt <agent>            the prompt to give that conversation
  mingle connect <agent> telegram          bot token on standard input
  mingle disconnect <connection-id>

For agents (inside a session):
  mingle message reply <msg> | send --to <chat|contact> | read <chat> | search <words>
  mingle chat list | info <chat> | hear <chat> --every 1h | --mute | --default
  mingle chat alias <chat> add|remove <name>
  mingle contact list [name] | info <user> | name <user> "name" | link <user> <user> | unlink <user> | note <user>
  mingle file get <file>
  mingle task create | run | tell | status | done | list | update
  mingle reminder set | list | snooze | cancel
  mingle whoami | manual

Add --json for machine-readable output.`;

// -------------------------------------------------------------------- main

async function main(): Promise<void> {
  const { values: flags, positionals } = parse(process.argv.slice(2));
  jsonMode = Boolean(flags.json);
  if (flags.version) {
    console.log(VERSION);
    return;
  }
  const [group, action, ...rest] = positionals;
  if (!group || flags.help) {
    console.log(HELP);
    return;
  }
  if (await agentCommand(group, action, rest, flags)) return;
  if (await adminCommand(group, action, rest, flags)) return;
  throw new CliError("unknown_command", `"${positionals.join(" ")}" is not a mingle command; run "mingle --help"`);
}

main().catch((error: unknown) => {
  if (error instanceof CliError) {
    console.error(`error: ${error.code}\nnext: ${error.next}`);
  } else if (error instanceof Error && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")) {
    console.error(`error: invalid_arguments\nnext: ${error.message}; run "mingle --help"`);
  } else {
    console.error(`error: internal\nnext: ${(error as Error)?.message ?? error}`);
  }
  process.exitCode = 1;
});
