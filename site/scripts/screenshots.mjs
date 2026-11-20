// Screenshots of the real console for the website, in English and Chinese, light and dark.
//
//   pnpm build && node site/scripts/screenshots.mjs   → site/img/<name>-<locale>-<theme>.png
//
// Starts a throwaway Mingle (its own MINGLE_HOME) per locale, seeds a believable agent,
// and renders each page with headless Chrome at 2x. Unlike scripts/ui-review.mjs, the
// content here is meant to look ordinary, not to stress the layout.

import { execFile, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { harnesses as siteHarnesses } from "./harnesses.mjs";

const run = promisify(execFile);
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = resolve("site/img");
mkdirSync(OUT, { recursive: true });

const copy = {
  en: {
    locale: "en-US",
    role: "You help our weekend hiking group: plan routes, check the weather, and remind everyone of the meeting time on Friday evening.",
    // Where Alex is: the first two hold the chats below, the rest are connected too.
    platforms: [
      ["telegram", "@alex_hikes_bot"],
      ["slack", "Alex"],
      ["discord", "Alex#2041"],
      ["wechat", "Alex"],
      ["github", "alex-hikes"],
    ],
    group: "Weekend hikers",
    nickname: "trail buddy",
    dm: "Sam",
    status: "Bash: curl -s https://api.open-meteo.com/v1/forecast?latitude=39.99",
    messages: [
      ["in", "Maya", "@Alex what's the weather like for the ridge trail on Saturday?", 3_600_000],
      [
        "out",
        null,
        "Sunny, 8–17 °C, light wind in the morning. Good for the north loop. Wind picks up after 2 pm, so I'd plan to be down by lunch.",
        3_540_000,
      ],
      ["in", "Sam", "Can you make me a packing list for 12 km with 600 m of climbing?", 1_800_000],
      [
        "out",
        null,
        "Here you go:\n1. 2 L of water\n2. Snacks for two breaks\n3. A rain shell\n4. A headlamp, just in case\nI've saved it to my notes, so I'll bring it up again next time.",
        1_740_000,
      ],
      ["in", "Maya", "@Alex can you remind everyone on Friday at 8 pm?", 240_000],
      ["out", null, "Done. I'll post the meeting point and time here on Friday at 8 pm and ask who's coming.", 200_000],
      ["in", "Leo", "@Alex which trail had the least climbing last time?", 30_000],
    ],
    // A third chat, on the third connection, so the activity shows more than two apps.
    thirdChat: [
      "#trail-club",
      "Priya",
      "@Alex can you pin Saturday's route here too?",
      "Pinned: north loop, 12 km, 540 m of climbing.",
      900_000,
    ],
    task: "Compare the three route options by climb, distance and transit, and recommend one by Friday",
    task2: "Look up the climbing on the last five trails",
    reminder: "Remind the group: Saturday 7:30 at the north gate, and count who's coming",
  },
  zh: {
    locale: "zh-CN",
    role: "帮我们的周末徒步群规划路线、查天气，并在周五晚上提醒大家集合时间。",
    platforms: [
      // The group is on Feishu, which sends the bot every message: it hears the whole group there.
      ["feishu", "Alex"],
      ["wechat", "Alex"],
      ["telegram", "@alex_hikes_bot"],
      ["dingtalk", "Alex"],
      ["github", "alex-hikes"],
    ],
    group: "周末徒步群",
    nickname: "小跟班",
    dm: "张三",
    status: "Bash: curl -s https://api.open-meteo.com/v1/forecast?latitude=39.99",
    messages: [
      ["in", "李雷", "@Alex 周六去香山那条线，天气怎么样？", 3_600_000],
      ["out", null, "周六晴，8–17℃，上午风小，适合走香山北线。下午两点后西北风会大一些，建议中午前下山。", 3_540_000],
      ["in", "张三", "帮我列个装备清单，12 公里，爬升 600 米左右。", 1_800_000],
      [
        "out",
        null,
        "清单如下：\n1. 2 升水\n2. 两次休息的零食\n3. 一件冲锋衣\n4. 头灯，以防万一\n我记到笔记里了，下次出发前再提醒你。",
        1_740_000,
      ],
      ["in", "李雷", "@Alex 周五晚上 8 点提醒一下大家。", 240_000],
      ["out", null, "好的。周五晚上 8 点我会在群里发集合地点和时间，并统计人数。", 200_000],
      ["in", "韩梅梅", "@Alex 上次哪条路线爬升最少？", 30_000],
    ],
    thirdChat: [
      "徒步俱乐部",
      "王芳",
      "@Alex 周六的路线也发到这里？",
      "好的：香山北线，12 公里，爬升 540 米。周六 7:30 北门集合。",
      900_000,
    ],
    task: "比较三条备选路线的爬升、距离和交通，周五前给出推荐",
    task2: "查一下最近五条路线的爬升",
    reminder: "在群里提醒周六 7:30 香山公园北门集合，并确认人数",
  },
};

async function startMingle(port) {
  const home = mkdtempSync(join(tmpdir(), "mingle-site-"));
  const daemon = spawn(process.execPath, ["dist/cli/main.js", "start", "--port", String(port), "--no-open"], {
    env: { ...process.env, MINGLE_HOME: home },
    stdio: "ignore",
  });
  const runtimePath = join(home, "runtime.json");
  for (let i = 0; i < 100 && !existsSync(runtimePath); i++) await new Promise((r) => setTimeout(r, 100));
  const { url, adminToken } = JSON.parse(readFileSync(runtimePath, "utf8"));
  const admin = async (method, path, body) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return response.json();
  };
  const stop = async () => {
    daemon.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    rmSync(home, { recursive: true, force: true });
  };
  return { home, url, adminToken, admin, stop };
}

async function shoot({ url, adminToken, path, file, locale, theme, width = 1280, height = 800 }) {
  const profile = mkdtempSync(join(tmpdir(), "mingle-chrome-"));
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--user-data-dir=${profile}`,
    `--lang=${locale}`,
    `--accept-lang=${locale}`,
    `--window-size=${width},${height}`,
    "--force-device-scale-factor=2",
    `--blink-settings=preferredColorScheme=${theme === "dark" ? 0 : 1}`,
    "--virtual-time-budget=6000",
    `--screenshot=${file}`,
    `${url}${path}#token=${adminToken}`,
  ];
  const once = () => run(CHROME, args, { timeout: 60_000 });
  try {
    await once().catch(() => (existsSync(file) ? undefined : once()));
  } catch (error) {
    if (!existsSync(file)) throw error;
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

// The handoff panel takes two clicks to open (Settings, then Hand off), so this one drives Chrome over CDP
// and shoots just that section.
const labels = {
  en: { settings: "Settings", open: "Hand off", title: "Handoff" },
  zh: { settings: "设置", open: "交接", title: "交接" },
};
async function shootHandoff({ url, adminToken, slug, file, lang, theme }) {
  const profile = mkdtempSync(join(tmpdir(), "mingle-chrome-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--user-data-dir=${profile}`,
    `--lang=${copy[lang].locale}`,
    `--accept-lang=${copy[lang].locale}`,
    "--remote-debugging-port=0",
    "about:blank",
  ]);
  try {
    const wsURL = await new Promise((resolve, reject) => {
      let err = "";
      chrome.stderr.on("data", (d) => {
        err += d;
        const found = err.match(/ws:\/\/[^\s]+/);
        if (found) resolve(found[0]);
      });
      chrome.on("exit", () => reject(new Error(`Chrome exited: ${err}`)));
    });
    const ws = new WebSocket(wsURL);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    let id = 0;
    const pending = new Map();
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (!msg.id || !pending.has(msg.id)) return;
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    });
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params, sessionId }));
      });
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const cdp = (method, params) => send(method, params, sessionId);
    const evaluate = async (expression) =>
      (await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 2, mobile: false });
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    await cdp("Page.navigate", { url: `${url}/a/${slug}#token=${adminToken}` });
    await sleep(2500);
    const l = labels[lang];
    const click = (text, selector = "button") =>
      evaluate(
        `(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.textContent.trim() === ${JSON.stringify(text)}); b?.click(); return !!b; })()`,
      );
    // The agent's own Settings tab, not the app's Settings in the sidebar.
    if (!(await click(l.settings, 'button[role="radio"]'))) throw new Error("handoff shot: no Settings tab");
    await sleep(800);
    if (!(await click(l.open))) throw new Error("handoff shot: no Hand off button");
    await sleep(2500);
    const box = await evaluate(`(() => {
      const s = [...document.querySelectorAll("section")].find((s) => s.firstElementChild?.textContent.trim().startsWith(${JSON.stringify(l.title)}));
      // The console scrolls its main pane, not the window. Leave room above for the pane's sticky header.
      s.scrollIntoView({ block: "start" });
      let pane = s.parentElement;
      while (pane && pane.scrollHeight <= pane.clientHeight) pane = pane.parentElement;
      if (pane) pane.scrollTop -= 100;
      const r = s.getBoundingClientRect();
      return { x: r.left - 16, y: r.top + scrollY - 16, width: r.width + 32, height: Math.min(r.height, 640) + 32 };
    })()`);
    await sleep(300);
    const { data } = await cdp("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { ...box, scale: 1 },
    });
    writeFileSync(file, Buffer.from(data, "base64"));
    ws.close();
  } finally {
    const exited = new Promise((r) => chrome.once("exit", r));
    chrome.kill();
    await exited;
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
}

// Marks for the site's harnesses, straight from OAR's brand assets ("on-light" / "on-dark", or one
// file for both), so ones not installed here are covered too. Installed ones are rewritten below.
const brands = resolve("node_modules/@botiverse/oar/assets/brands");
for (const [id] of siteHarnesses) {
  const file = `${id}.svg`;
  for (const theme of ["light", "dark"]) {
    const variant = join(brands, `${id}-on-${theme}.svg`);
    copyFileSync(existsSync(variant) ? variant : join(brands, file), resolve(`site/icons/${id}-${theme}.svg`));
  }
}

let port = 7600 + Math.floor(Math.random() * 100);
for (const [lang, c] of Object.entries(copy)) {
  const m = await startMingle(port++);
  try {
    const harnesses = await m.admin("GET", "/v1/admin/harnesses");
    // The harness marks come from OAR; keep a copy for the site's "brains" row.
    mkdirSync(resolve("site/icons"), { recursive: true });
    for (const h of harnesses)
      for (const theme of ["light", "dark"])
        if (h.icon?.[theme])
          writeFileSync(
            resolve(`site/icons/${h.id}-${theme}.svg`),
            decodeURIComponent(h.icon[theme].replace(/^data:image\/svg\+xml,/, "")),
          );
    const claude = harnesses.find((h) => h.id === "claude")?.id ?? harnesses[0]?.id ?? "claude";
    const alex = await m.admin("POST", "/v1/admin/agents", { name: "Alex", harness: claude, role: c.role });
    // One agent: the site's story is one Alex in every chat app, not a row of agents (docs/spec.md 1.5).

    const db = new DatabaseSync(join(m.home, "mingle.db"));
    const now = Date.now();
    const insert = (sql, ...args) => db.prepare(sql).run(...args);
    const conn = (id, platform, bot, owner) =>
      insert(
        "INSERT INTO connections (id, agent_id, platform, bot_id, bot_name, state, state_detail, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'connected', NULL, ?, ?, ?)",
        id,
        alex.id,
        platform,
        id,
        bot,
        owner,
        now,
        now,
      );
    for (const [i, [platform, bot]] of c.platforms.entries()) conn(`n${i + 1}`, platform, bot, "u1");
    insert(
      "INSERT INTO chats (id, connection_id, platform_id, kind, name, listen, aliases, created_at, updated_at) VALUES ('c1','n1','-1','group',?,1,?,?,?)",
      c.group,
      // It hears the whole group, which also calls it by a nickname (docs/spec.md 4.2).
      JSON.stringify([c.nickname]),
      now,
      now,
    );
    insert(
      "INSERT INTO chats (id, connection_id, platform_id, kind, name, created_at, updated_at) VALUES ('c2','n2','7','dm',?,?,?)",
      c.dm,
      now,
      now,
    );
    c.messages.forEach(([dir, sender, body, ago], i) => {
      const chat = sender === c.dm || (dir === "out" && c.messages[i - 1]?.[1] === c.dm) ? "c2" : "c1";
      const state = dir === "out" ? "sent" : i === c.messages.length - 1 ? "answering" : "replied";
      insert(
        "INSERT INTO messages (id, chat_id, direction, platform_id, sender_id, sender_name, body, attachments, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
        `m${i}`,
        chat,
        dir,
        `m${i}`,
        sender ? "u" : null,
        sender,
        body,
        state,
        now - ago,
      );
    });
    {
      const [name, sender, ask, reply, ago] = c.thirdChat;
      insert(
        "INSERT INTO chats (id, connection_id, platform_id, kind, name, created_at, updated_at) VALUES ('c3','n3','-3','group',?,?,?)",
        name,
        now,
        now,
      );
      const message = db.prepare(
        "INSERT INTO messages (id, chat_id, direction, platform_id, sender_id, sender_name, body, attachments, state, created_at) VALUES (?, 'c3', ?, ?, ?, ?, ?, NULL, ?, ?)",
      );
      message.run("x1", "in", "x1", "u3", sender, ask, "replied", now - ago);
      message.run("x2", "out", "x2", null, null, reply, "sent", now - ago + 50_000);
    }
    // Two things under way beside the conversation (docs/spec.md 4.13): one at work, one waiting its turn.
    insert(
      "INSERT INTO tasks (id, agent_id, title, status, from_message, from_chat, line_state, brief, created_at, updated_at) VALUES ('t1', ?, ?, 'in_progress', 'x1', 'c3', 'running', 'brief', ?, ?)",
      alex.id,
      c.task,
      now - 12 * 60_000,
      now,
    );
    insert(
      "INSERT INTO tasks (id, agent_id, title, status, from_message, from_chat, line_state, brief, created_at, updated_at) VALUES ('t2', ?, ?, 'in_progress', ?, 'c1', 'queued', 'brief', ?, ?)",
      alex.id,
      c.task2,
      // The group's latest question started it.
      `m${c.messages.length - 1}`,
      now - 2 * 60_000,
      now,
    );
    insert(
      "INSERT INTO reminders (id, agent_id, body, rule, timezone, next_fire_at, created_at) VALUES ('r1', ?, ?, 'once', 'Asia/Shanghai', ?, ?)",
      alex.id,
      c.reminder,
      now + 2 * 86_400_000,
      now,
    );
    insert("UPDATE agents SET status = 'working', status_detail = ? WHERE id = ?", c.status, alex.id);
    db.close();

    const pages = [
      ["agent", `/a/${alex.slug}`],
      // Smaller windows for the step-by-step shots, so the console reads at the size it's shown.
      ["new", "/new", 1000, 760],
      ["connect", `/a/${alex.slug}/connect`, 1000, 640],
    ];
    for (const theme of ["light", "dark"])
      await Promise.all(
        pages.map(([name, path, width, height]) =>
          shoot({
            ...m,
            path,
            file: join(OUT, `${name}-${lang}-${theme}.png`),
            locale: c.locale,
            theme,
            width,
            height,
          }),
        ),
      );
    for (const theme of ["light", "dark"])
      await shootHandoff({ ...m, slug: alex.slug, file: join(OUT, `handoff-${lang}-${theme}.png`), lang, theme });
  } finally {
    await m.stop();
  }
}
console.log(`screenshots in ${OUT}`);
