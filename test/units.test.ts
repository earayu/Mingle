/// <reference lib="dom" />
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toInbound } from "../src/channels/telegram/telegram.ts";
import { excerpt, formatMessage, formatReminder } from "../src/core/format.ts";
import { split } from "../src/core/outbox.ts";
import { nextFire, parseDuration } from "../src/core/schedule.ts";
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
      { id: "c12", connectionId: "n1", platformId: "-100", kind: "group", name: "Weekend hikes", parentId: null },
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
  };
  const contact = {
    id: "u7k2",
    connectionId: "n1",
    platformId: "o9cq@im.wechat",
    name: null,
    alias: null,
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
