/// <reference lib="dom" />
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toInbound } from "../src/channels/telegram/telegram.ts";
import {
  CHECK_DEFAULT_FOR_MS,
  CHECK_MAX_FOR_MS,
  changedText,
  checkCommand,
  checkUntil,
  outcome,
} from "../src/core/check.ts";
import { excerpt, formatMessage, formatReminder } from "../src/core/format.ts";
import { split } from "../src/core/outbox.ts";
import { nextFire, parseDuration } from "../src/core/schedule.ts";
import { checkEnvironment, runCommand } from "../src/platform/command.ts";
import { applyShellEnvironment } from "../src/platform/shell-env.ts";
import { Store } from "../src/store/store.ts";
import { type LocalePreference, localePreference, resolveLocale } from "../web/src/locale.ts";
import { applyTheme, savedTheme } from "../web/src/theme.ts";

describe("excerpt", () => {
  it("keeps short messages whole, with the match marked", () => {
    expect(excerpt("the Ridge route is open", "ridge")).toBe("the <match>Ridge</match> route is open");
    expect(excerpt("nothing here", "ridge")).toBe("nothing here");
  });

  it("cuts a long message to a window around the match, more after it than before", () => {
    const body = `${"a".repeat(200)} Ridge route ${"b".repeat(200)}`;
    expect(excerpt(body, "ridge", 10, 20)).toBe(`…${"a".repeat(9)} <match>Ridge</match> route ${"b".repeat(13)}…`);
  });

  it("finds a word of the query when the whole query is not there", () => {
    // The first word of the query that the message contains.
    expect(excerpt("is the ridge open on saturday?", "saturday ridge")).toBe(
      "is the ridge open on <match>saturday</match>?",
    );
  });

  it("slides the window inward near either end", () => {
    expect(excerpt(`ridge ${"x".repeat(100)}`, "ridge", 10, 10)).toBe(`<match>ridge</match> ${"x".repeat(19)}…`);
    expect(excerpt(`${"x".repeat(100)} ridge`, "ridge", 10, 10)).toBe(`…${"x".repeat(19)} <match>ridge</match>`);
  });

  it("counts characters, not UTF-16 units", () => {
    const body = `${"山".repeat(50)}徒步路线${"水".repeat(50)}`;
    expect(excerpt(body, "徒步", 5, 5)).toBe(`…${"山".repeat(5)}<match>徒步</match>路线${"水".repeat(3)}…`);
  });

  it("keeps the original match offset after Unicode case conversion changes length", () => {
    expect(excerpt("İ Ridge route", "ridge")).toBe("İ <match>Ridge</match> route");
    expect(excerpt("İstanbul ridge", "İstanbul")).toBe("<match>İstanbul</match> ridge");
  });

  it("keeps the match offset after an astral character", () => {
    expect(excerpt("𐐷 ridge route", "ridge")).toBe("𐐷 <match>ridge</match> route");
  });

  it("finds a query that is only punctuation", () => {
    expect(excerpt("try a+b ridge", "a+b")).toBe("try <match>a+b</match> ridge");
  });
});

describe("formatMessage", () => {
  it("puts everything an agent needs on one header line", () => {
    const text = formatMessage(
      {
        id: "m8f2a",
        chatId: "c12",
        direction: "in",
        platformId: "1",
        senderId: "u1",
        senderName: 'Zhang "San"',
        body: "hello",
        attachments: [{ id: "f3a1", ref: "x", name: "route.gpx" }],
        replyTo: null,
        triggers: true,
        state: "received",
        createdAt: Date.UTC(2026, 10, 11, 6, 2),
      },
      {
        id: "c12",
        connectionId: "n1",
        platformId: "-100",
        kind: "group",
        name: "Weekend hikes",
        parentId: null,
        access: null,
        listen: false,
        hearPace: { kind: "auto" as const },
        hearTier: null,
        aliases: [],
        peerId: null,
      },
      "feishu",
      { ownerId: "u1" },
    );
    const [header, body] = text.split("\n");
    expect(header).toMatch(
      /^\[msg=m8f2a chat=c12 im=feishu group="Weekend hikes" from="Zhang 'San'" owner file=f3a1:"route\.gpx" time=2026-11-11T\d\d:\d\d[+-]\d\d:\d\d\]$/,
    );
    expect(body).toBe("hello");
  });
});

describe("message header contacts", () => {
  const message = {
    id: "m8f2a",
    chatId: "c12",
    direction: "in" as const,
    platformId: "1",
    senderId: "o9cq@im.wechat",
    senderName: "",
    body: "hi",
    attachments: [],
    replyTo: null,
    triggers: true,
    state: "received" as const,
    createdAt: Date.UTC(2026, 10, 11, 6, 2),
  };
  const chat = {
    id: "c12",
    connectionId: "n1",
    platformId: "o9cq@im.wechat",
    kind: "dm" as const,
    name: null,
    parentId: null,
    access: null,
    listen: false,
    hearPace: { kind: "auto" as const },
    hearTier: null,
    aliases: [],
    peerId: null,
  };
  const contact = {
    id: "u7k2",
    connectionId: "n1",
    platformId: "o9cq@im.wechat",
    name: null,
    alias: null,
    access: null,
    isBot: false,
    personId: null,
    personName: null,
    linkedBy: null,
    profile: null,
    updatedAt: 0,
  };

  it("leaves out a name the platform never gave, and always carries the contact ID", () => {
    const text = formatMessage(message, chat, "wechat", { ownerId: "o9cq@im.wechat", contact });
    expect(text.split("\n")[0]).toMatch(/^\[msg=m8f2a chat=c12 im=wechat dm user=u7k2 owner time=.+\]$/);
  });

  it("uses the name the agent or owner gave over the platform's", () => {
    const named = { ...contact, name: "Mei W.", alias: "Mei" };
    expect(formatMessage(message, chat, "wechat", { contact: named })).toContain('from="Mei" user=u7k2 time=');
    expect(formatMessage(message, chat, "wechat", { contact: { ...named, alias: null } })).toContain('from="Mei W."');
  });

  it("marks a bot, and never the owner", () => {
    const bot = { ...contact, name: "Bob", isBot: true };
    expect(formatMessage(message, chat, "wechat", { contact: bot })).toContain('from="Bob" user=u7k2 bot time=');
    expect(formatMessage(message, chat, "wechat", { ownerId: "o9cq@im.wechat", contact: bot })).toContain(
      "user=u7k2 owner time=",
    );
  });

  it("writes no from= with a platform ID when there is neither a contact nor a name", () => {
    const text = formatMessage(message, chat, "wechat");
    expect(text.split("\n")[0]).not.toContain("from=");
    expect(text.split("\n")[0]).not.toContain("o9cq@im.wechat");
  });
});

describe("formatReminder", () => {
  const reminder = {
    id: "r2",
    agentId: "a1",
    body: "Check the forecast",
    rule: "once",
    timezone: "UTC",
    chatId: "c3",
    sourceMessageId: "m4",
    nextFireAt: null,
    lastFiredAt: null,
    createdAt: 0,
    check: null,
  };

  it("quotes the source message line by line under the reminder", () => {
    const text = formatReminder(reminder, 0, '[msg=m4 chat=c3 im=slack dm from="Ana"]\nfirst\nsecond');
    expect(text.split("\n").slice(1)).toEqual([
      "Check the forecast",
      '> [msg=m4 chat=c3 im=slack dm from="Ana"]',
      "> first",
      "> second",
    ]);
  });

  it("cuts a long source and marks the cut", () => {
    const text = formatReminder(reminder, 0, `[msg=m4]\n${"字".repeat(2000)}`);
    expect(text.endsWith("…")).toBe(true);
    expect([...text].length).toBeLessThan(600);
  });

  it("is just the reminder without a source", () => {
    expect(formatReminder(reminder, 0)).toMatch(/^\[reminder=r2 chat=c3 time=.+\]\nCheck the forecast$/);
  });

  it("marks a check in the header and puts what it found before the quote", () => {
    const text = formatReminder(reminder, 0, "[msg=m4]\nis CI done?", {
      state: "changed",
      text: changedText("pass"),
    });
    expect(text.split("\n")).toEqual([
      expect.stringMatching(/^\[reminder=r2 chat=c3 time=.+ check=changed\]$/),
      "Check the forecast",
      "Check output now:",
      "pass",
      "> [msg=m4]",
      "> is CI done?",
    ]);
  });
});

describe("reminder checks", () => {
  it("compares the trimmed output and keeps only its start", () => {
    const a = outcome({ code: 0, stdout: "pass\n" });
    const b = outcome({ code: 0, stdout: "  pass" });
    expect(a.ok && b.ok && a.hash === b.hash).toBe(true);
    const long = outcome({ code: 0, stdout: "x".repeat(10_000) });
    expect(long.ok && long.output.length).toBe(4000);
    const other = outcome({ code: 0, stdout: `${"x".repeat(9_999)}y` });
    expect(long.ok && other.ok && long.hash !== other.hash).toBe(true);
  });

  it("says why a run failed with a fixed string, never the command's error output", () => {
    expect(outcome({ code: 2, stdout: "" })).toEqual({ ok: false, error: "exited with 2" });
    expect(outcome({ code: null, stdout: "", killed: "timeout" })).toEqual({
      ok: false,
      error: "timed out after 60s",
    });
    expect(outcome({ code: null, stdout: "", killed: "output_too_large" })).toMatchObject({ ok: false });
    expect(outcome({ code: null, stdout: "", killed: "cancelled" })).toEqual({
      ok: false,
      error: "was cancelled",
    });
    expect(outcome({ code: null, stdout: "", killed: "spawn_failed" })).toEqual({
      ok: false,
      error: "could not run",
    });
  });

  it("refuses an empty or huge command", () => {
    expect(() => checkCommand("  ")).toThrow(/check_required|shell command/);
    expect(() => checkCommand("x".repeat(5000))).toThrow(/4000/);
    expect(checkCommand(" gh pr checks 1 ")).toBe("gh pr checks 1");
  });

  it("parses --for: 7d by default, up to 90d, or forever with no deadline", () => {
    const now = 1_700_000_000_000;
    expect(checkUntil(undefined, now)).toBe(now + CHECK_DEFAULT_FOR_MS);
    expect(checkUntil("3d", now)).toBe(now + 3 * 86_400_000);
    expect(checkUntil("90d", now)).toBe(now + CHECK_MAX_FOR_MS);
    expect(checkUntil("forever", now)).toBeNull();
    expect(checkUntil(" FOREVER ", now)).toBeNull();
    for (const bad of ["91d", "0m", "0d", "", "never", null, 42]) {
      expect(() => checkUntil(bad, now)).toThrow(/check_for_invalid|forever/);
    }
  });

  it("gives a check only the allowlisted variables, Windows names case-insensitively", () => {
    const env = checkEnvironment(
      {
        PATH: "/bin",
        HOME: "/home/a",
        USER: "a",
        LOGNAME: "a",
        SHELL: "/bin/sh",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        LC_TIME: "C",
        TZ: "UTC",
        TMPDIR: "/tmp",
        HTTPS_PROXY: "http://user:secret@proxy:1",
        MY_API_KEY: "secret",
        MINGLE_TOKEN: "secret",
        RANDOM_THING: "x",
      },
      "linux",
    );
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/home/a");
    expect(env.LC_ALL).toBe("en_US.UTF-8");
    expect(Object.keys(env).sort()).toEqual(
      ["HOME", "LANG", "LC_ALL", "LC_TIME", "LOGNAME", "PATH", "SHELL", "TMPDIR", "TZ", "USER"].sort(),
    );
    const win = checkEnvironment(
      { Path: "C:\\bin", systemroot: "C:\\Windows", USERPROFILE: "C:\\Users\\a", ComSpec: "cmd", MY_TOKEN: "s" },
      "win32",
    );
    expect(win).toEqual({
      Path: "C:\\bin",
      systemroot: "C:\\Windows",
      USERPROFILE: "C:\\Users\\a",
      ComSpec: "cmd",
    });
  });

  it("runs a shell command and kills it on a timeout", async () => {
    const ok = await runCommand('node -e "process.stdout.write(String(6*7))"', {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
    });
    expect(ok).toEqual({ code: 0, stdout: "42" });
    const slow = await runCommand('node -e "setTimeout(() => {}, 20000)"', {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 300,
      maxOutputBytes: 1024,
    });
    expect(slow.killed).toBe("timeout");
    const loud = await runCommand("node -e \"process.stdout.write('x'.repeat(5000))\"", {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
    });
    expect(loud.killed).toBe("output_too_large");
  });

  it("keeps nothing of standard error and reports a spawn failure generically", async () => {
    const complaining = await runCommand("node -e \"console.error('leak: hunter2'); process.exit(3)\"", {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
    });
    expect(complaining).toEqual({ code: 3, stdout: "" });
    const dir = mkdtempSync(join(tmpdir(), "mingle-cmd-"));
    try {
      const gone = join(dir, "gone");
      const failed = await runCommand("true", {
        cwd: gone,
        env: process.env,
        timeoutMs: 10_000,
        maxOutputBytes: 1024,
      });
      expect(failed.killed).toBeTruthy();
      expect(JSON.stringify(failed)).not.toContain("ENOENT");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops the whole shell tree on timeout, cancellation or abort", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mingle-cmd-"));
    try {
      // `node tree.cjs` spawns a real grandchild (no shell dialect), then waits on it. The
      // grandchild proves it started, would prove it survived the kill, holds the inherited
      // stdout open, and always exits on its own so a failed test orphans nothing for long.
      writeFileSync(
        join(dir, "tree.cjs"),
        `const { spawn } = require("node:child_process");
const { join } = require("node:path");
const grandchild = spawn(process.execPath, [join(__dirname, "grandchild.cjs"), process.argv[2] ?? "2500"], {
  stdio: ["ignore", "inherit", "ignore"],
});
grandchild.on("exit", () => process.exit(0));
setTimeout(() => process.exit(0), 60_000).unref();
`,
      );
      writeFileSync(
        join(dir, "grandchild.cjs"),
        `const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
writeFileSync(join(__dirname, "started.txt"), "1");
setTimeout(() => writeFileSync(join(__dirname, "survived.txt"), "x"), Number(process.argv[2]));
setTimeout(() => process.exit(0), 60_000);
`,
      );
      const started = join(dir, "started.txt");
      const survived = join(dir, "survived.txt");
      const waitStarted = async () => {
        for (let i = 0; i < 200 && !existsSync(started); i++) await new Promise((r) => setTimeout(r, 100));
        // Only a started grandchild makes "no survived marker" mean the kill worked.
        expect(existsSync(started)).toBe(true);
        return Date.now();
      };
      const launch = (timeoutMs: number, surviveMs: number, signal?: AbortSignal) =>
        runCommand(`node tree.cjs ${surviveMs}`, {
          cwd: dir,
          env: process.env,
          timeoutMs,
          maxOutputBytes: 1024,
          ...(signal ? { signal } : {}),
        });
      const untilPast = async (from: number, ms: number) =>
        new Promise((r) => setTimeout(r, Math.max(0, from + ms - Date.now())));

      // Kill at 4s while the marker would land at 5s after start: never may.
      const at = Date.now();
      const timed = launch(4000, 5000);
      const startedAt = await waitStarted();
      expect((await timed).killed).toBe("timeout");
      // The descendant holds the pipe: bounded release, not a hang and not an instant leak.
      expect(Date.now() - at).toBeLessThan(20_000);
      await untilPast(startedAt, 5500);
      expect(existsSync(survived)).toBe(false);

      rmSync(started, { force: true });
      const controller = new AbortController();
      const cancelled = launch(30_000, 2000, controller.signal);
      const abortedAt = await waitStarted();
      controller.abort();
      expect((await cancelled).killed).toBe("cancelled");
      await untilPast(abortedAt, 2500);
      expect(existsSync(survived)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("folds a CI statusCheckRollup into one waiting or finished value", async () => {
    const manual = readFileSync(new URL("../src/cli/manual.md", import.meta.url), "utf8");
    const expression = (/--jq '((?:[^'\\]|\\.)*)'/.exec(manual)?.[1] ?? "").replace(/\\"/g, '"');
    expect(expression).toBe(
      '.statusCheckRollup // [] | if length == 0 or any(.[]; if .__typename == "CheckRun" then .status != "COMPLETED" else (.state == "PENDING" or .state == "EXPECTED") end) then "waiting" else "finished" end',
    );
    const hasJq = (() => {
      try {
        execFileSync("jq", ["--version"]);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    })();
    // No jq on this runner (Windows CI): the verbatim-expression assertion above still holds.
    if (!hasJq) return;
    const evaluate = (entries: { __typename: string; status?: string; state?: string }[]): string =>
      execFileSync(
        "jq",
        ["-n", "--argjson", "r", JSON.stringify({ statusCheckRollup: entries }), `$r | ${expression}`],
        { encoding: "utf8" },
      ).trim();
    expect(evaluate([])).toBe('"waiting"');
    expect(evaluate([{ __typename: "CheckRun", status: "QUEUED" }])).toBe('"waiting"');
    expect(evaluate([{ __typename: "CheckContext", state: "PENDING" }])).toBe('"waiting"');
    expect(evaluate([{ __typename: "CheckContext", state: "EXPECTED" }])).toBe('"waiting"');
    // Mixed: one finished job and one still pending is still waiting.
    expect(
      evaluate([
        { __typename: "CheckRun", status: "COMPLETED" },
        { __typename: "CheckRun", status: "IN_PROGRESS" },
      ]),
    ).toBe('"waiting"');
    expect(evaluate([{ __typename: "CheckRun", status: "COMPLETED" }])).toBe('"finished"');
    expect(evaluate([{ __typename: "CheckContext", state: "FAILURE" }])).toBe('"finished"');
    expect(
      evaluate([
        { __typename: "CheckRun", status: "COMPLETED" },
        { __typename: "CheckContext", state: "SUCCESS" },
      ]),
    ).toBe('"finished"');
  });
});

describe("schedule", () => {
  it("parses durations", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("2d")).toBe(172_800_000);
    expect(() => parseDuration("soon")).toThrow(/invalid_duration/);
  });

  it("finds the next daily and weekly time", () => {
    const base = new Date(2026, 10, 11, 10, 0).getTime(); // Wednesday 10:00 local
    expect(new Date(nextFire("daily@09:00", base))).toEqual(new Date(2026, 10, 12, 9, 0));
    expect(new Date(nextFire("daily@11:30", base))).toEqual(new Date(2026, 10, 11, 11, 30));
    expect(new Date(nextFire("weekly:mon,fri@09:00", base))).toEqual(new Date(2026, 10, 13, 9, 0));
    expect(nextFire("every:15m", base)).toBe(base + 900_000);
    expect(() => nextFire("weekly:funday@09:00", base)).toThrow(/invalid_rule/);
  });
});

describe("split", () => {
  it("keeps short text whole and cuts long text at line breaks", () => {
    expect(split("short", 10)).toEqual(["short"]);
    const parts = split(`${"a".repeat(8)}\n${"b".repeat(8)}`, 12);
    expect(parts).toEqual(["a".repeat(8), "b".repeat(8)]);
    expect(split("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });
});

describe("telegram toInbound", () => {
  const me = { id: 42, is_bot: true, first_name: "Alex", username: "alex_bot" };
  const group = { id: -100, type: "supergroup" as const, title: "Weekend hikes" };
  const from = { id: 7, is_bot: false, first_name: "Zhang", last_name: "San" };

  it("strips the bot mention and marks the message as addressed", () => {
    const text = "@alex_bot what is the weather?";
    const inbound = toInbound(
      { message_id: 5, from, chat: group, date: 1, text, entities: [{ type: "mention", offset: 0, length: 9 }] },
      me,
    );
    expect(inbound).toMatchObject({
      platformId: "5",
      text: "what is the weather?",
      addressedToBot: true,
      chat: { platformId: "-100", kind: "group", name: "Weekend hikes" },
      sender: { id: "7", name: "Zhang San", isBot: false },
      sentAt: 1000,
    });
  });

  it("ignores group chatter that does not address the bot", () => {
    const inbound = toInbound({ message_id: 6, from, chat: group, date: 1, text: "anyone up for Saturday?" }, me);
    expect(inbound?.addressedToBot).toBe(false);
  });

  it("treats replies to the bot and /command@bot as addressed", () => {
    const reply = toInbound(
      {
        message_id: 7,
        from,
        chat: group,
        date: 1,
        text: "thanks",
        reply_to_message: { message_id: 3, from: me, chat: group, date: 1 },
      },
      me,
    );
    expect(reply).toMatchObject({ addressedToBot: true, replyTo: "3" });
    const stop = toInbound({ message_id: 8, from, chat: group, date: 1, text: "/stop@alex_bot" }, me);
    expect(stop).toMatchObject({ addressedToBot: true, text: "/stop" });
  });

  it("maps direct messages, topics and attachments", () => {
    const dm = toInbound(
      {
        message_id: 9,
        from,
        chat: { id: 7, type: "private", first_name: "Zhang" },
        date: 1,
        caption: "route",
        document: { file_id: "F1", file_name: "route.gpx", file_size: 10 },
      },
      me,
    );
    expect(dm).toMatchObject({ chat: { kind: "dm", platformId: "7" }, addressedToBot: true, text: "route" });
    expect(dm?.attachments).toEqual([{ id: "F1", name: "route.gpx", size: 10 }]);
    const topic = toInbound(
      {
        message_id: 10,
        message_thread_id: 4,
        is_topic_message: true,
        from,
        chat: { ...group, is_forum: true },
        date: 1,
        text: "@alex_bot hi",
        entities: [{ type: "mention", offset: 0, length: 9 }],
        reply_to_message: { message_id: 4, chat: group, date: 1 },
      },
      me,
    );
    expect(topic).toMatchObject({ chat: { kind: "thread", platformId: "-100:4" } });
    expect(topic?.replyTo).toBeUndefined();
  });
});

describe("applyShellEnvironment", () => {
  const sep = delimiter;
  it("takes the login shell's variables, so keys set in ~/.zshrc reach the harness", () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin", HOME: "/Users/a", MINGLE_HOME: "/data" };
    const changed = applyShellEnvironment(
      env,
      {
        PATH: `/opt/homebrew/bin${sep}/usr/bin`,
        ANTHROPIC_API_KEY: "sk-ant-test",
        ANTHROPIC_BASE_URL: "https://gateway.example",
        HOME: "/Users/a",
        MINGLE_HOME: "/elsewhere",
        PWD: "/tmp",
        SHLVL: "2",
        GONE: null,
      },
      "/app/node/bin",
    );
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://gateway.example");
    expect(env.MINGLE_HOME).toBe("/data");
    expect(env.PWD).toBeUndefined();
    expect(env.PATH).toBe(`/opt/homebrew/bin${sep}/usr/bin${sep}/app/node/bin`);
    expect(changed.sort()).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "PATH"]);
  });

  it("keeps the inherited environment and adds the bundled Node.js when the shell gives nothing", () => {
    const env: Record<string, string | undefined> = { PATH: `/app/node/bin${sep}/usr/bin`, KEEP: "1" };
    expect(applyShellEnvironment(env, {}, "/app/node/bin")).toEqual([]);
    expect(env.PATH).toBe(`/app/node/bin${sep}/usr/bin`);
    const bare: Record<string, string | undefined> = {};
    applyShellEnvironment(bare, {}, "/app/node/bin");
    expect(bare.PATH).toBe("/app/node/bin");
  });
});

describe("language preference", () => {
  // absent storage, a legacy stored "system", and invalid values all mean follow the system
  it.each([[null], ["system"], ["fr"], [""]])("localePreference(%j) is system", (saved) => {
    expect(localePreference(saved)).toBe("system");
  });

  it.each(["en", "zh-CN"])("localePreference(%s) keeps the explicit choice", (saved) => {
    expect(localePreference(saved)).toBe(saved);
  });

  it.each([
    [["zh-CN"], "zh-CN"],
    [["zh-Hans-CN"], "zh-CN"],
    [["zh-TW"], "zh-CN"],
    [["ZH_cn"], "zh-CN"],
    [["en-GB", "zh-CN"], "en"],
    [["zh-CN", "en-US"], "zh-CN"],
    [["fr-FR", "zh-CN", "en"], "zh-CN"],
    [["de-DE", "en-US", "zh-CN"], "en"],
    [[], "en"],
    [["fr-FR"], "en"],
    [["zho", "english"], "en"],
  ])("system resolves %j to %s", (languages, expected) => {
    expect(resolveLocale("system", languages)).toBe(expected);
  });

  it.each([
    ["en" as LocalePreference, ["zh-CN", "zh-TW"], "en"],
    ["zh-CN" as LocalePreference, ["en-GB", "en-US"], "zh-CN"],
  ])("an explicit %s choice wins over a %j list", (preference, languages, expected) => {
    expect(resolveLocale(preference, languages)).toBe(expected);
  });

  it("switching back to system resolves the current list", () => {
    const preference = localePreference(null);
    expect(resolveLocale(preference, ["en-GB"])).toBe("en");
  });
});

describe("appearance", () => {
  let dataset: Record<string, string>;
  let storage: Map<string, string>;
  beforeEach(() => {
    dataset = {};
    storage = new Map();
    vi.stubGlobal("document", { documentElement: { dataset } });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    vi.stubGlobal("window", {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(["light", "dark", "system"] as const)("restores %s and synchronizes native appearance", async (theme) => {
    storage.set("mingle.theme", theme);
    const call = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", { mygo: { call } });
    await applyTheme(savedTheme());
    expect(dataset.theme).toBe(theme === "system" ? undefined : theme);
    expect(dataset.nativeTheme).toBe(theme);
    expect(call).toHaveBeenCalledWith("Appearance.SetTheme", theme);
    expect(storage.get("mingle.theme")).toBe(theme);
  });

  it("returns to system without storing a resolved light or dark choice", async () => {
    await applyTheme("dark");
    await applyTheme("system");
    expect(dataset.theme).toBeUndefined();
    expect(dataset.nativeTheme).toBeUndefined();
    expect(savedTheme()).toBe("system");
    storage.set("mingle.theme", "invalid");
    expect(savedTheme()).toBe("system");
  });

  it("keeps explicit colors with an older shell and recovers on the next request", async () => {
    const call = vi.fn().mockRejectedValueOnce(new Error("unknown method")).mockResolvedValue(undefined);
    vi.stubGlobal("window", { mygo: { call } });
    await applyTheme("light");
    expect(dataset.theme).toBe("light");
    expect(dataset.nativeTheme).toBeUndefined();
    await applyTheme("dark");
    expect(dataset.nativeTheme).toBe("dark");
  });

  it("serializes rapid selections so a slow native reply cannot win", async () => {
    const first = Promise.withResolvers<void>();
    const call = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    vi.stubGlobal("window", { mygo: { call } });
    const dark = applyTheme("dark");
    await Promise.resolve();
    const light = applyTheme("light");
    expect(dataset.theme).toBe("light");
    expect(dataset.nativeTheme).toBeUndefined();
    expect(call).toHaveBeenCalledTimes(1);
    first.resolve();
    await Promise.all([dark, light]);
    expect(call.mock.calls).toEqual([
      ["Appearance.SetTheme", "dark"],
      ["Appearance.SetTheme", "light"],
    ]);
    expect(dataset.nativeTheme).toBe("light");
    expect(savedTheme()).toBe("light");
  });
});

describe("package smoke", () => {
  it.skipIf(process.platform === "win32")("smokes a tarball in a fresh extraction directory", async () => {
    const run = promisify(execFile);
    const work = mkdtempSync(join(tmpdir(), "mingle-package-test-"));
    try {
      const app = join(work, "app");
      mkdirSync(join(app, "bin"), { recursive: true });
      mkdirSync(join(app, "dist", "cli"), { recursive: true });
      symlinkSync(process.execPath, join(app, "bin", "node"));
      writeFileSync(
        join(app, "dist", "cli", "main.js"),
        `if (process.argv.includes("--version")) {
  console.log("0.0.0");
} else {
  const { createServer } = require("node:http");
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/v1/health" ? 200 : 404);
    res.end("ok");
  });
  server.listen(Number(process.argv[process.argv.indexOf("--port") + 1]), "127.0.0.1");
  process.stdin.on("end", () => server.close());
  process.stdin.resume();
}
`,
      );
      const artifact = join(work, "fixture.tar.gz");
      await run("tar", ["-czf", artifact, "-C", app, "."]);
      const { stdout } = await run(process.execPath, ["scripts/package-smoke.mjs", artifact], { timeout: 20_000 });
      expect(stdout).toContain("--version: 0.0.0");
      expect(stdout).toContain("start: /v1/health ok");
      expect(stdout).toContain("  ok");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("message search", () => {
  it("finds messages with every word, short words included, and treats % and _ literally", () => {
    const store = new Store(":memory:");
    const agent = store.createAgent({ name: "Alex", slug: "alex", harness: "scripted" });
    const connection = store.createConnection({ agentId: agent.id, platform: "telegram", secretRef: "s1" });
    const chatId = store.upsertChat({ connectionId: connection.id, platformId: "1", kind: "group" }).id;
    let seq = 0;
    const add = (body: string) =>
      store.insertInbound({
        chatId,
        platformId: `p${++seq}`,
        senderId: "u1",
        senderName: "Zhang San",
        body,
        attachments: [],
        replyTo: null,
        triggers: true,
        createdAt: 1_000 + seq,
      });
    add("周六去香山徒步，天气不错");
    add("周日下雨，徒步取消");
    add("ridge route is open on saturday");
    add("discount 50% off");
    const bodies = (q: string) => store.search(agent.id, q).map((m) => m.body);
    expect(bodies("徒步 天气")).toEqual(["周六去香山徒步，天气不错"]);
    expect(bodies("徒步")).toEqual(["周日下雨，徒步取消", "周六去香山徒步，天气不错"]);
    expect(bodies("saturday ridge")).toEqual(["ridge route is open on saturday"]);
    expect(bodies('"route is open"')).toEqual(["ridge route is open on saturday"]);
    expect(bodies('"open route"')).toEqual([]);
    expect(bodies("0%")).toEqual(["discount 50% off"]);
    expect(bodies("%")).toEqual(["discount 50% off"]);
    expect(bodies("_")).toEqual([]);
    store.close();
  });
});
