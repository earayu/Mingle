import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ChannelConnection,
  ChannelEvents,
  ConnectionState,
  InboundMessage,
  OnboardingEvent,
} from "../src/channels/channel.ts";
import {
  decodeAttributedBody,
  imessageChannel,
  type MessageRow,
  normalizeHandle,
  ScriptError,
  type ScriptRunner,
  stripName,
  toInbound,
} from "../src/channels/imessage/imessage.ts";
import { until } from "./helpers.ts";

const APPLE_EPOCH_MS = 978_307_200_000;
const ME = "alex.agent@icloud.com";
const OWNER = "+8613800000000";
const FRIEND = "+8613900000000";
const DM = `iMessage;-;${OWNER}`;
const GROUP = "iMessage;+;chat123456789";

/** An NSAttributedString in Apple's typedstream format, as Messages stores it in `attributedBody`. */
function attributedBody(text: string, extra = ""): Uint8Array {
  const bytes = Buffer.from(text, "utf8");
  const length =
    bytes.length < 0x80
      ? Buffer.from([bytes.length])
      : Buffer.concat([Buffer.from([0x81]), Buffer.from(Uint16Array.of(bytes.length).buffer)]);
  return Buffer.concat([
    Buffer.from(
      "\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08",
      "latin1",
    ),
    Buffer.from("NSString\x01\x94\x84\x01+", "latin1"),
    length,
    bytes,
    Buffer.from(`\x86\x84\x02iI\x01${extra}`, "latin1"),
  ]);
}

/** A chat.db with the tables and columns the adapter reads. */
class FakeMessages {
  readonly db: DatabaseSync;
  private handles = new Map<string, number>();
  private chats = new Map<string, number>();
  readonly path: string;
  constructor(path: string) {
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, style INTEGER, display_name TEXT, chat_identifier TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, date INTEGER,
        thread_originator_guid TEXT, handle_id INTEGER, is_from_me INTEGER, associated_message_type INTEGER DEFAULT 0,
        item_type INTEGER DEFAULT 0, account TEXT);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
      CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, filename TEXT, mime_type TEXT, transfer_name TEXT, total_bytes INTEGER);
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    `);
    this.chat(DM, 45, [OWNER]);
    this.chat(GROUP, 43, [OWNER, FRIEND], "Hikers");
  }
  handle(id: string): number {
    let rowid = this.handles.get(id);
    if (!rowid) {
      rowid = Number(this.db.prepare("INSERT INTO handle (id) VALUES (?)").run(id).lastInsertRowid);
      this.handles.set(id, rowid);
    }
    return rowid;
  }
  chat(guid: string, style: number, members: string[], name?: string): void {
    const rowid = Number(
      this.db
        .prepare("INSERT INTO chat (guid, style, display_name, chat_identifier) VALUES (?, ?, ?, ?)")
        .run(guid, style, name ?? null, guid.split(";").pop() ?? guid).lastInsertRowid,
    );
    this.chats.set(guid, rowid);
    for (const m of members)
      this.db.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)").run(rowid, this.handle(m));
  }
  add(
    chat: string,
    m: {
      guid: string;
      from?: string;
      text?: string | null;
      body?: Uint8Array;
      at?: number;
      replyTo?: string;
      tapback?: boolean;
      file?: { path: string; name: string; mime: string; size: number };
    },
  ): void {
    const fromMe = !m.from;
    const at = m.at ?? Date.now();
    const rowid = Number(
      this.db
        .prepare(
          `INSERT INTO message (guid, text, attributedBody, date, thread_originator_guid, handle_id, is_from_me,
             associated_message_type, account) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          m.guid,
          m.text === undefined ? null : m.text,
          m.body ?? null,
          BigInt(at - APPLE_EPOCH_MS) * 1_000_000n,
          m.replyTo ?? null,
          m.from ? this.handle(m.from) : 0,
          fromMe ? 1 : 0,
          m.tapback ? 2000 : 0,
          fromMe ? `E:${ME}` : null,
        ).lastInsertRowid,
    );
    this.db
      .prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)")
      .run(this.chats.get(chat) ?? 0, rowid);
    if (m.file) {
      const a = Number(
        this.db
          .prepare("INSERT INTO attachment (filename, mime_type, transfer_name, total_bytes) VALUES (?, ?, ?, ?)")
          .run(m.file.path, m.file.mime, m.file.name, m.file.size).lastInsertRowid,
      );
      this.db.prepare("INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)").run(rowid, a);
    }
  }
}

/** Stands in for osascript: records calls and, like Messages, writes what it sends into chat.db. */
function fakeScripts(messages: FakeMessages) {
  const calls: { script: string; args: readonly string[] }[] = [];
  let failWith: Error | undefined;
  let n = 0;
  const run: ScriptRunner = async (script, args) => {
    calls.push({ script, args });
    if (failWith) throw failWith;
    if (script.includes("description of")) return `${ME}\n`;
    if (script.includes("to chat id")) messages.add(args[1] ?? "", { guid: `sent-${++n}`, text: args[0] ?? "" });
    return "";
  };
  return {
    run,
    calls,
    fail: (error: Error | undefined) => {
      failWith = error;
    },
  };
}

function recorder() {
  const messages: InboundMessage[] = [];
  const states: ConnectionState[] = [];
  const events: ChannelEvents = {
    onMessage: (m) => messages.push(m),
    onState: (s) => states.push(s),
    onMembership: () => {},
  };
  return { events, messages, states };
}

async function collect(iter: AsyncIterable<OnboardingEvent>): Promise<OnboardingEvent[]> {
  const out: OnboardingEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

function row(partial: Partial<MessageRow>): MessageRow {
  return {
    rowid: 1,
    guid: "g1",
    text: "hello",
    attributedBody: null,
    date: Date.now() - APPLE_EPOCH_MS,
    replyTo: null,
    sender: OWNER,
    chatGuid: DM,
    chatStyle: 45,
    chatName: null,
    chatIdentifier: OWNER,
    ...partial,
  };
}

describe("imessage mapping", () => {
  it("reads text from attributedBody, short and long", () => {
    expect(decodeAttributedBody(attributedBody("你好 Alex"))).toBe("你好 Alex");
    const long = "x".repeat(300);
    expect(decodeAttributedBody(attributedBody(long))).toBe(long);
    expect(decodeAttributedBody(Buffer.from("not a typedstream"))).toBeUndefined();
  });

  it("treats every direct message as addressed, and only named or mentioned group messages", () => {
    const me = { handle: ME, name: "Alex" };
    const dm = toInbound(row({ text: null, attributedBody: attributedBody("ping") }), [], me);
    expect(dm).toMatchObject({ text: "ping", addressedToBot: true, chat: { kind: "dm", platformId: DM } });

    const chatter = toInbound(row({ chatGuid: GROUP, chatStyle: 43, chatName: "Hikers", text: "lunch?" }), [], me);
    expect(chatter).toMatchObject({ addressedToBot: false, chat: { kind: "group", name: "Hikers" } });

    const named = toInbound(row({ chatGuid: GROUP, chatStyle: 43, text: "@Alex what's the plan?" }), [], me);
    expect(named).toMatchObject({ addressedToBot: true, text: "what's the plan?" });

    const leading = toInbound(row({ chatGuid: GROUP, chatStyle: 43, text: "alex，帮我查一下天气" }), [], me);
    expect(leading).toMatchObject({ addressedToBot: true, text: "帮我查一下天气" });

    // A confirmed iMessage mention carries the handle; the visible text is the contact's name.
    const mention = attributedBody("Bot please summarise", `__kIMMentionConfirmedMention\x86${ME}`);
    const mentioned = toInbound(row({ chatGuid: GROUP, chatStyle: 43, text: null, attributedBody: mention }), [], me);
    expect(mentioned?.addressedToBot).toBe(true);
  });

  it("keeps attachments, quotes and the time", () => {
    const at = Date.UTC(2026, 10, 14, 3, 0, 0);
    const inbound = toInbound(
      row({ text: "\uFFFC", replyTo: "g0", date: at - APPLE_EPOCH_MS }),
      [{ filename: "~/Library/Messages/Attachments/a/b/IMG_1.HEIC", mime: "image/heic", name: "IMG_1.HEIC", size: 42 }],
      { handle: ME, name: "Alex" },
    );
    expect(inbound).toMatchObject({
      text: "",
      replyTo: "g0",
      sentAt: at,
      attachments: [{ id: "~/Library/Messages/Attachments/a/b/IMG_1.HEIC", name: "IMG_1.HEIC", mime: "image/heic" }],
    });
  });

  it("only matches the name as a word", () => {
    expect(stripName("Alexander, hi", "Alex")).toBeUndefined();
    expect(stripName("ask @Alex about it", "Alex")).toBe("ask about it");
    expect(normalizeHandle(" +86 138-0000-0000 ")).toBe("+8613800000000");
    expect(normalizeHandle("Me@iCloud.com")).toBe("me@icloud.com");
    expect(normalizeHandle("13800000000")).toBeUndefined();
  });
});

describe("imessage channel", () => {
  let dir: string;
  let messages: FakeMessages;
  let live: ChannelConnection | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mingle-imessage-"));
    messages = new FakeMessages(join(dir, "chat.db"));
  });
  afterEach(async () => {
    await live?.close();
    live = undefined;
    messages.db.close();
    try {
      chmodSync(join(dir, "chat.db"), 0o644);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  it("onboards the Mac's account and makes the person who connects it the owner", async () => {
    messages.add(DM, { guid: "old-out", text: "hi" });
    const scripts = fakeScripts(messages);
    const channel = imessageChannel({ dbPath: messages.path, runScript: scripts.run, now: () => 1000 });
    const events = await collect(
      channel.onboard({ owner: "+86 138 0000 0000" }, new AbortController().signal, { agentName: "Alex" }),
    );
    expect(events).toEqual([
      {
        kind: "succeeded",
        credentials: { owner: OWNER, handle: ME, name: "Alex", since: "1000" },
        bot: { id: ME, name: ME },
        ownerId: OWNER,
      },
    ]);
  });

  it("refuses the owner's own Apple ID, a bad owner, and missing permissions", async () => {
    messages.add(DM, { guid: "old-out", text: "hi" });
    const scripts = fakeScripts(messages);
    const channel = imessageChannel({ dbPath: messages.path, runScript: scripts.run });
    const signal = new AbortController().signal;
    expect(await collect(channel.onboard({ owner: ME }, signal))).toEqual([{ kind: "failed", code: "owner_account" }]);
    expect(await collect(channel.onboard({ owner: "someone" }, signal))).toEqual([
      { kind: "failed", code: "invalid_credentials" },
    ]);

    scripts.fail(new ScriptError("execution error: Not authorized to send Apple events to Messages. (-1743)"));
    expect(await collect(channel.onboard({ owner: OWNER }, signal))).toEqual([
      { kind: "failed", code: "permission_missing" },
    ]);
  });

  // Windows chmod does not implement POSIX read permissions.
  it.skipIf(process.platform === "win32")("reports an unreadable Messages database during onboarding", async () => {
    messages.add(DM, { guid: "old-out", text: "hi" });
    const channel = imessageChannel({ dbPath: messages.path, runScript: fakeScripts(messages).run });
    chmodSync(messages.path, 0o000);
    expect(await collect(channel.onboard({ owner: OWNER }, new AbortController().signal))).toEqual([
      { kind: "failed", code: "permission_missing" },
    ]);
  });

  it("delivers new messages from others, skipping its own, tapbacks and old history", async () => {
    messages.add(DM, { guid: "ancient", from: OWNER, text: "from last week", at: Date.now() - 7 * 86_400_000 });
    messages.add(DM, { guid: "recent", from: OWNER, text: "sent while Mingle was off", at: Date.now() - 60_000 });
    const scripts = fakeScripts(messages);
    const rec = recorder();
    live = await imessageChannel({ dbPath: messages.path, runScript: scripts.run, pollMs: 20 }).connect(
      { owner: OWNER, handle: ME, name: "Alex", since: "0" },
      rec.events,
    );
    await until(() => rec.messages.length === 1);
    expect(rec.messages[0]?.platformId).toBe("recent");

    messages.add(DM, { guid: "mine", text: "my own reply" });
    messages.add(DM, { guid: "like", from: OWNER, text: "Loved “hi”", tapback: true });
    messages.add(GROUP, { guid: "g-chatter", from: FRIEND, text: "anyone up for a hike?" });
    messages.add(GROUP, { guid: "g-ask", from: FRIEND, text: "@Alex what's the weather on Saturday?" });
    await until(() => rec.messages.length === 3);
    expect(rec.messages.map((m) => [m.platformId, m.addressedToBot, m.text])).toEqual([
      ["recent", true, "sent while Mingle was off"],
      ["g-chatter", false, "anyone up for a hike?"],
      ["g-ask", true, "what's the weather on Saturday?"],
    ]);
    expect(await live.listMembers({ platformId: GROUP, kind: "group" })).toEqual([
      { id: OWNER, name: OWNER, isBot: false },
      { id: FRIEND, name: FRIEND, isBot: false },
    ]);
  });

  it("sends through Messages, reports the sent message's id, and flattens Markdown", async () => {
    const scripts = fakeScripts(messages);
    live = await imessageChannel({ dbPath: messages.path, runScript: scripts.run, pollMs: 20 }).connect(
      { owner: OWNER, handle: ME, name: "Alex", since: "0" },
      recorder().events,
    );
    const result = await live.send({
      chat: { platformId: GROUP, kind: "group" },
      text: "**Done.** See `notes.md`",
      replyTo: "g-ask",
    });
    expect(result).toEqual({ kind: "sent", platformId: "sent-1", degraded: ["quote_dropped", "markdown_flattened"] });
    expect(scripts.calls.at(-1)?.args).toEqual(["Done. See notes.md", GROUP]);

    const file = join(dir, "report.txt");
    writeFileSync(file, "MINGLE-FILE-OK");
    await live.send({ chat: { platformId: DM, kind: "dm" }, text: "", files: [{ path: file }] });
    expect(scripts.calls.at(-1)).toMatchObject({ args: [file, DM] });
    expect(scripts.calls.at(-1)?.script).toContain("POSIX file");

    await live.messageUser?.(OWNER, "Hi, I'm **Alex**.");
    expect(scripts.calls.at(-1)).toMatchObject({ args: ["Hi, I'm Alex.", OWNER] });
    expect(scripts.calls.at(-1)?.script).toContain("participant");
  });

  it("maps send failures without retrying what may have gone out", async () => {
    const scripts = fakeScripts(messages);
    live = await imessageChannel({ dbPath: messages.path, runScript: scripts.run, pollMs: 20 }).connect(
      { owner: OWNER, handle: ME, name: "Alex", since: "0" },
      recorder().events,
    );
    const chat = { platformId: DM, kind: "dm" as const };
    scripts.fail(new ScriptError("Not authorized to send Apple events to Messages. (-1743)"));
    expect(await live.send({ chat, text: "x" })).toEqual({ kind: "failed", code: "forbidden", retryable: false });
    scripts.fail(new ScriptError("", true));
    expect(await live.send({ chat, text: "x" })).toEqual({ kind: "uncertain" });
    scripts.fail(new ScriptError('Messages got an error: Can’t get chat id "nope". (-1728)'));
    expect(await live.send({ chat, text: "x" })).toEqual({ kind: "failed", code: "chat_gone", retryable: false });
  });

  it("copies attachments out of Messages' storage", async () => {
    const src = join(dir, "IMG_1.HEIC");
    writeFileSync(src, "image bytes");
    live = await imessageChannel({ dbPath: messages.path, runScript: fakeScripts(messages).run }).connect(
      { owner: OWNER, handle: ME, name: "Alex", since: "0" },
      recorder().events,
    );
    const to = join(dir, "copy.heic");
    await live.download({ id: src, name: "IMG_1.HEIC" }, to);
    expect(readFileSync(to, "utf8")).toBe("image bytes");
  });

  // Windows locks open SQLite files; these exercise the macOS adapter's POSIX replacement/reopen behavior.
  it.skipIf(process.platform === "win32")(
    "reconnects after the database goes away, and catches up on what arrived meanwhile",
    async () => {
      const rec = recorder();
      live = await imessageChannel({ dbPath: messages.path, runScript: fakeScripts(messages).run, pollMs: 20 }).connect(
        { owner: OWNER, handle: ME, name: "Alex", since: "0" },
        rec.events,
      );
      const away = join(dir, "away.db");
      renameSync(messages.path, away);
      await until(() => rec.states.some((s) => s.kind === "reconnecting"));
      messages.add(DM, { guid: "during", from: OWNER, text: "are you there?" });
      renameSync(away, messages.path);
      await until(() => rec.states.at(-1)?.kind === "connected", 5000);
      await until(() => rec.messages.some((m) => m.platformId === "during"));
    },
  );

  it.skipIf(process.platform === "win32")("stops and asks the person when read access is taken away", async () => {
    const rec = recorder();
    live = await imessageChannel({ dbPath: messages.path, runScript: fakeScripts(messages).run, pollMs: 20 }).connect(
      { owner: OWNER, handle: ME, name: "Alex", since: "0" },
      rec.events,
    );
    // The open connection keeps reading; access is checked again on the next reopen.
    renameSync(messages.path, join(dir, "gone.db"));
    await until(() => rec.states.some((s) => s.kind === "reconnecting"));
    renameSync(join(dir, "gone.db"), messages.path);
    chmodSync(messages.path, 0o000);
    await until(() => rec.states.at(-1)?.kind === "error", 5000);
    expect(rec.states.at(-1)).toEqual({ kind: "error", code: "permission_missing" });

    const fresh = recorder();
    await expect(
      imessageChannel({ dbPath: messages.path, runScript: fakeScripts(messages).run }).connect(
        { owner: OWNER, handle: ME, name: "Alex", since: "0" },
        fresh.events,
      ),
    ).rejects.toThrow();
    expect(fresh.states).toEqual([{ kind: "error", code: "permission_missing" }]);
  });
});
