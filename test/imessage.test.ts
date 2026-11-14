import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
  AGENT_MARK,
  countActiveAccounts,
  decodeAttributedBody,
  imessageChannel,
  parseAccounts,
  ScriptError,
  type ScriptRunner,
} from "../src/channels/imessage/imessage.ts";
import { until } from "./helpers.ts";

const APPLE_EPOCH_MS = 978_307_200_000;
const ME = "me@icloud.com";
const MY_PHONE = "+8613800000000";
const FRIEND = "+8613900000000";
const SELF = `iMessage;-;${ME}`;
const SELF_BY_PHONE = `iMessage;-;${MY_PHONE}`;
const FRIEND_DM = `iMessage;-;${FRIEND}`;
const GROUP = "iMessage;+;chat123456789";
const CREDS = { handle: ME, handles: `${ME},${MY_PHONE}`, since: "0" };

/** An NSAttributedString in Apple's typedstream format, as Messages stores it in `attributedBody`. */
function attributedBody(text: string): Uint8Array {
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
    Buffer.from("\x86\x84\x02iI\x01", "latin1"),
  ]);
}

/** A chat.db with the tables and columns the adapter reads, laid out like a real one. */
class FakeMessages {
  readonly db: DatabaseSync;
  readonly path: string;
  private chats = new Map<string, number>();
  constructor(path: string) {
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, style INTEGER, chat_identifier TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, date INTEGER,
        handle_id INTEGER, is_from_me INTEGER, associated_message_type INTEGER DEFAULT 0,
        item_type INTEGER DEFAULT 0, service TEXT, account TEXT, destination_caller_id TEXT);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, filename TEXT, mime_type TEXT, transfer_name TEXT, total_bytes INTEGER);
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    `);
    this.chat(SELF, 45, ME);
    this.chat(SELF_BY_PHONE, 45, MY_PHONE);
    this.chat(FRIEND_DM, 45, FRIEND);
    this.chat(GROUP, 43, "chat123456789");
  }
  private chat(guid: string, style: number, identifier: string): void {
    const rowid = Number(
      this.db.prepare("INSERT INTO chat (guid, style, chat_identifier) VALUES (?, ?, ?)").run(guid, style, identifier)
        .lastInsertRowid,
    );
    this.chats.set(guid, rowid);
  }
  /** Real self-chat rows keep the text only in attributedBody; `fromMe` defaults to true. */
  add(
    chat: string,
    m: {
      guid: string;
      text?: string;
      fromMe?: boolean;
      at?: number;
      tapback?: boolean;
      file?: { path: string; name: string; mime: string; size: number };
    },
  ): void {
    const fromMe = m.fromMe ?? true;
    const rowid = Number(
      this.db
        .prepare(
          `INSERT INTO message (guid, text, attributedBody, date, handle_id, is_from_me, associated_message_type,
             service, account, destination_caller_id) VALUES (?, NULL, ?, ?, 1, ?, ?, 'iMessage', ?, ?)`,
        )
        .run(
          m.guid,
          m.text === undefined ? null : attributedBody(m.text),
          BigInt((m.at ?? Date.now()) - APPLE_EPOCH_MS) * 1_000_000n,
          fromMe ? 1 : 0,
          m.tapback ? 2000 : 0,
          `E:${ME}`,
          fromMe ? MY_PHONE : null,
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
function fakeScripts(messages: FakeMessages, opts: { mark?: boolean } = {}) {
  const calls: { script: string; args: readonly string[] }[] = [];
  let failWith: Error | undefined;
  let accounts = `E:${ME}\nE:${ME}\n`;
  let n = 0;
  const keep = (text: string) => (opts.mark === false ? text.replace(AGENT_MARK, "") : text);
  const run: ScriptRunner = async (script, args) => {
    calls.push({ script, args });
    if (failWith) throw failWith;
    if (script.includes("description of")) return accounts;
    const target = args[1] ?? "";
    const chat = target.includes(";") ? target : `iMessage;-;${target}`;
    if (script.includes("POSIX file")) {
      const path = args[0] ?? "";
      messages.add(chat, {
        guid: `sent-${++n}`,
        text: "￼",
        file: { path, name: basename(path), mime: "text/plain", size: 1 },
      });
    } else messages.add(chat, { guid: `sent-${++n}`, text: keep(args[0] ?? "") });
    return "";
  };
  return {
    run,
    calls,
    fail: (error: Error | undefined) => {
      failWith = error;
    },
    signOut: () => {
      accounts = "";
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

describe("imessage parsing", () => {
  it("reads text from attributedBody, short and long", () => {
    expect(decodeAttributedBody(attributedBody("你好 Alex"))).toBe("你好 Alex");
    const long = "x".repeat(300);
    expect(decodeAttributedBody(attributedBody(long))).toBe(long);
    expect(decodeAttributedBody(Buffer.from("not a typedstream"))).toBeUndefined();
  });

  it("reads the account handles Messages reports", () => {
    expect(parseAccounts("E:Me@iCloud.com\nE:me@icloud.com\nmissing value\nP:+8613800000000\n")).toEqual([
      ME,
      MY_PHONE,
    ]);
    expect(parseAccounts("")).toEqual([]);
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

  const connect = async (scripts = fakeScripts(messages), rec = recorder()) => {
    live = await imessageChannel({ dbPath: messages.path, runScript: scripts.run, pollMs: 20 }).connect(
      CREDS,
      rec.events,
    );
    return { live, rec, scripts };
  };

  it("onboards the Mac's own account and makes it the owner, with nothing to fill in", async () => {
    messages.add(SELF, { guid: "old", text: "hi" });
    const scripts = fakeScripts(messages);
    const channel = imessageChannel({ dbPath: messages.path, runScript: scripts.run, now: () => 1000 });
    expect(channel.onboarding).toEqual({ kind: "credentials", fields: [] });
    expect(await collect(channel.onboard(undefined, new AbortController().signal))).toEqual([
      {
        kind: "succeeded",
        credentials: { handle: ME, handles: `${ME},${MY_PHONE}`, since: "1000" },
        bot: { id: ME, name: ME },
        ownerId: ME,
      },
    ]);
  });

  it("says what is missing: iMessage sign-in, Automation, Full Disk Access", async () => {
    const scripts = fakeScripts(messages);
    const channel = imessageChannel({ dbPath: messages.path, runScript: scripts.run });
    const signal = new AbortController().signal;
    scripts.signOut();
    expect(await collect(channel.onboard(undefined, signal))).toEqual([{ kind: "failed", code: "not_signed_in" }]);
    scripts.fail(new ScriptError("execution error: Not authorized to send Apple events to Messages. (-1743)"));
    expect(await collect(channel.onboard(undefined, signal))).toEqual([{ kind: "failed", code: "permission_missing" }]);
  });

  // Windows chmod does not implement POSIX read permissions.
  it.skipIf(process.platform === "win32")("reports an unreadable Messages database during onboarding", async () => {
    const channel = imessageChannel({ dbPath: messages.path, runScript: fakeScripts(messages).run });
    chmodSync(messages.path, 0o000);
    expect(await collect(channel.onboard(undefined, new AbortController().signal))).toEqual([
      { kind: "failed", code: "permission_missing" },
    ]);
  });

  describe("setup checks", () => {
    const APP = "io.github.earayu.mingle";
    /** The user's privacy database, with only the table and columns the checks read. */
    const tcc = (rows: [client: string, authValue: number][]) => {
      const path = join(dir, "TCC.db");
      rmSync(path, { force: true });
      const db = new DatabaseSync(path);
      db.exec(
        "CREATE TABLE access (service TEXT, client TEXT, client_type INTEGER, auth_value INTEGER, indirect_object_identifier TEXT)",
      );
      for (const [client, value] of rows) {
        db.prepare("INSERT INTO access VALUES ('kTCCServiceAppleEvents', ?, 0, ?, 'com.apple.MobileSMS')").run(
          client,
          value,
        );
      }
      db.close();
      return path;
    };
    const setupOf = (opts: { accounts?: number; tccPath?: string; scripts?: ReturnType<typeof fakeScripts> } = {}) => {
      const opened: (readonly string[])[] = [];
      const scripts = opts.scripts ?? fakeScripts(messages);
      const channel = imessageChannel({
        dbPath: messages.path,
        runScript: scripts.run,
        setup: {
          activeAccounts: async () => opts.accounts,
          tccPath: opts.tccPath ?? join(dir, "missing-TCC.db"),
          bundleId: APP,
          appPath: async () => "/Applications/Mingle.app",
          open: async (args) => {
            opened.push(args);
          },
        },
      });
      if (!channel.setup) throw new Error("iMessage has setup checks");
      return { setup: channel.setup, opened, scripts };
    };
    const states = async (setup: { check(): Promise<{ checks: readonly { id: string; state: string }[] }> }) =>
      Object.fromEntries((await setup.check()).checks.map((c) => [c.id, c.state]));

    it("ticks off what this Mac already has, in the order the person does it", async () => {
      const { setup } = setupOf({ accounts: 1, tccPath: tcc([[APP, 2]]) });
      const result = await setup.check();
      expect(result.app).toBe("Mingle");
      expect(result.checks).toEqual([
        { id: "signed_in", state: "ok" },
        { id: "full_disk_access", state: "ok" },
        { id: "automation", state: "ok" },
      ]);
    });

    it("tells a missing sign-in apart from preferences it cannot read", async () => {
      expect((await states(setupOf({ accounts: 0 }).setup)).signed_in).toBe("missing");
      expect((await states(setupOf({}).setup)).signed_in).toBe("unknown");
    });

    it("reads permission to control Messages for this app only, never by asking", async () => {
      const { setup, scripts } = setupOf({ accounts: 1, tccPath: tcc([["com.apple.Terminal", 2]]) });
      expect((await states(setup)).automation).toBe("missing");
      expect((await states(setupOf({ accounts: 1, tccPath: tcc([[APP, 0]]) }).setup)).automation).toBe("denied");
      // Checking never runs AppleScript, so macOS never shows a prompt the person did not ask for.
      expect(scripts.calls).toEqual([]);
    });

    it("asks macOS for control of Messages only when the person clicks Allow", async () => {
      const { setup, scripts } = setupOf({ accounts: 0 });
      expect(await states(setup)).toMatchObject({ signed_in: "missing", automation: "missing" });
      await setup.act("allow_automation");
      expect(scripts.calls).toHaveLength(1);
      // Controlling Messages worked and it listed an iMessage account: both are known now.
      expect(await states(setup)).toMatchObject({ signed_in: "ok", automation: "ok" });
    });

    it("keeps a refused permission as not done", async () => {
      const scripts = fakeScripts(messages);
      scripts.fail(new ScriptError("execution error: Not authorized to send Apple events to Messages. (-1743)"));
      const { setup } = setupOf({ accounts: 1, scripts });
      await setup.act("allow_automation");
      expect((await states(setup)).automation).toBe("missing");
    });

    it.skipIf(process.platform === "win32")(
      "waits on Full Disk Access before it can tell about Automation",
      async () => {
        chmodSync(messages.path, 0o000);
        expect(await states(setupOf({ accounts: 1 }).setup)).toEqual({
          signed_in: "ok",
          full_disk_access: "missing",
          automation: "unknown",
        });
      },
    );

    it("opens the right System Settings pane, Messages, or the app in Finder", async () => {
      const { setup, opened } = setupOf({ accounts: 1 });
      for (const action of ["open_messages", "open_full_disk_access", "open_automation", "reveal_app"]) {
        await setup.act(action);
      }
      expect(opened).toEqual([
        ["-a", "Messages"],
        ["x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"],
        ["x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"],
        ["-R", "/Applications/Mingle.app"],
      ]);
    });

    it("counts the accounts `defaults read` prints", () => {
      expect(countActiveAccounts('(\n    "51883BEE-E35B-4CED-9692-6B6EAC928BF3"\n)\n')).toBe(1);
      expect(countActiveAccounts('(\n    "A",\n    "B"\n)')).toBe(2);
      expect(countActiveAccounts("(\n)\n")).toBe(0);
    });
  });

  it("hears the owner in the self-chat only, never other people's chats", async () => {
    messages.add(SELF, { guid: "ancient", text: "from last week", at: Date.now() - 7 * 86_400_000 });
    messages.add(SELF, { guid: "recent", text: "sent while Mingle was off", at: Date.now() - 60_000 });
    const { rec } = await connect();
    await until(() => rec.messages.length === 1);

    messages.add(FRIEND_DM, { guid: "friend", text: "hey, dinner?", fromMe: false });
    messages.add(FRIEND_DM, { guid: "my-reply", text: "sure" });
    messages.add(GROUP, { guid: "group", text: "anyone up for a hike?", fromMe: false });
    messages.add(SELF, { guid: "like", text: "Loved “hi”", tapback: true });
    messages.add(SELF_BY_PHONE, { guid: "by-phone", text: "what's on my calendar?" });
    await until(() => rec.messages.length === 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(rec.messages.map((m) => [m.platformId, m.text, m.chat.kind, m.sender.id, m.addressedToBot])).toEqual([
      ["recent", "sent while Mingle was off", "dm", ME, true],
      ["by-phone", "what's on my calendar?", "dm", ME, true],
    ]);
  });

  it("never reads its own replies back, marked or not", async () => {
    const { live, rec } = await connect();
    const sent = await live.send({ chat: { platformId: SELF, kind: "dm" }, text: "**Done.** See `notes.md`" });
    expect(sent).toEqual({ kind: "sent", platformId: "sent-1", degraded: ["markdown_flattened"] });
    await live.messageUser?.(ME, "Hi, I'm Alex.");
    messages.add(SELF, { guid: "after", text: "thanks" });
    await until(() => rec.messages.length === 1);
    expect(rec.messages[0]?.platformId).toBe("after");

    // If the marker were ever stripped, the remembered text still gives the reply away, once.
    const unmarked = fakeScripts(messages, { mark: false });
    await live.close();
    const second = await connect(unmarked);
    await second.live.send({ chat: { platformId: SELF, kind: "dm" }, text: "ok" });
    messages.add(SELF, { guid: "owner-ok", text: "ok" });
    await until(() => second.rec.messages.some((m) => m.platformId === "owner-ok"));
    // "after" comes again from the catch-up on connect; the core drops it as a duplicate.
    expect(second.rec.messages.map((m) => m.platformId)).toEqual(["after", "owner-ok"]);
  });

  it("sends with the invisible marker, files without being read back", async () => {
    const { live, rec, scripts } = await connect();
    await live.send({ chat: { platformId: SELF, kind: "dm" }, text: "Here it is", replyTo: "x" });
    expect(scripts.calls.at(-1)?.args).toEqual([`Here it is${AGENT_MARK}`, SELF]);

    const file = join(dir, "report.txt");
    writeFileSync(file, "MINGLE-FILE-OK");
    await live.send({ chat: { platformId: SELF, kind: "dm" }, text: "", files: [{ path: file }] });
    // Staged into Messages' own attachments folder, the only place it sends files from.
    const staged = scripts.calls.at(-1)?.args[0] ?? "";
    expect(staged.startsWith(join(dir, "Attachments", "mingle"))).toBe(true);
    expect(basename(staged)).toBe("report.txt");
    expect(readFileSync(staged, "utf8")).toBe("MINGLE-FILE-OK");
    expect(scripts.calls.at(-1)?.args[1]).toBe(SELF);
    messages.add(SELF, {
      guid: "photo",
      text: "￼",
      file: { path: join(dir, "IMG_1.HEIC"), name: "IMG_1.HEIC", mime: "image/heic", size: 9 },
    });
    await until(() => rec.messages.length === 1);
    expect(rec.messages[0]).toMatchObject({ platformId: "photo", text: "", attachments: [{ name: "IMG_1.HEIC" }] });
  });

  it("counts a message once when it shows up both as sent and as received", async () => {
    const { rec } = await connect();
    const at = Date.now();
    messages.add(SELF, { guid: "copy-1", text: "ping", at });
    messages.add(SELF, { guid: "copy-2", text: "ping", at: at + 500, fromMe: false });
    messages.add(SELF, { guid: "again", text: "ping", at: at + 2000 });
    await until(() => rec.messages.length === 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(rec.messages.map((m) => m.platformId)).toEqual(["copy-1", "again"]);
  });

  it("maps send failures without retrying what may have gone out", async () => {
    const { live, scripts } = await connect();
    const chat = { platformId: SELF, kind: "dm" as const };
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
    const { live } = await connect();
    const to = join(dir, "copy.heic");
    await live.download({ id: src, name: "IMG_1.HEIC" }, to);
    expect(readFileSync(to, "utf8")).toBe("image bytes");
  });

  // Windows locks open SQLite files; these exercise the macOS adapter's POSIX replacement/reopen behavior.
  it.skipIf(process.platform === "win32")(
    "reconnects after the database goes away, and catches up on what arrived meanwhile",
    async () => {
      const { rec } = await connect();
      const away = join(dir, "away.db");
      renameSync(messages.path, away);
      await until(() => rec.states.some((s) => s.kind === "reconnecting"));
      messages.add(SELF, { guid: "during", text: "are you there?" });
      renameSync(away, messages.path);
      await until(() => rec.states.at(-1)?.kind === "connected", 5000);
      await until(() => rec.messages.some((m) => m.platformId === "during"));
    },
  );

  it.skipIf(process.platform === "win32")("stops and asks the person when read access is taken away", async () => {
    const { rec } = await connect();
    renameSync(messages.path, join(dir, "gone.db"));
    await until(() => rec.states.some((s) => s.kind === "reconnecting"));
    renameSync(join(dir, "gone.db"), messages.path);
    chmodSync(messages.path, 0o000);
    await until(() => rec.states.at(-1)?.kind === "error", 5000);
    expect(rec.states.at(-1)).toEqual({ kind: "error", code: "permission_missing" });

    const fresh = recorder();
    await expect(
      imessageChannel({ dbPath: messages.path, runScript: fakeScripts(messages).run }).connect(CREDS, fresh.events),
    ).rejects.toThrow();
    expect(fresh.states).toEqual([{ kind: "error", code: "permission_missing" }]);
  });
});
