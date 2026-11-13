// Screenshots of the real console for the website, in English and Chinese, light and dark.
//
//   pnpm build && node site/scripts/screenshots.mjs   → site/img/<name>-<locale>-<theme>.png
//
// Starts a throwaway Mingle (its own MINGLE_HOME) per locale, seeds a believable agent,
// and renders each page with headless Chrome at 2x. Unlike scripts/ui-review.mjs, the
// content here is meant to look ordinary, not to stress the layout.

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const run = promisify(execFile);
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = resolve("site/img");
mkdirSync(OUT, { recursive: true });

const copy = {
  en: {
    locale: "en-US",
    role: "You help our weekend hiking group: plan routes, check the weather, and remind everyone of the meeting time on Friday evening.",
    second: ["Iris", "Reads the articles our book club shares and keeps a list of what we liked."],
    third: ["Kit", "My coding partner for side projects."],
    group: "Weekend hikers",
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
    task: "Compare the three route options by climb, distance and transit, and recommend one by Friday",
    task2: "Book the minibus for Saturday",
    reminder: "Remind the group: Saturday 7:30 at the north gate, and count who's coming",
  },
  zh: {
    locale: "zh-CN",
    role: "帮我们的周末徒步群规划路线、查天气，并在周五晚上提醒大家集合时间。",
    second: ["读书会小助手", "整理读书会里分享的文章，记下大家推荐的书。"],
    third: ["Kit", "陪我写业余项目的编程搭档。"],
    group: "周末徒步群",
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
    task: "比较三条备选路线的爬升、距离和交通，周五前给出推荐",
    task2: "订周六的小巴",
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
    const codex = harnesses.find((h) => h.id === "codex")?.id ?? claude;
    const alex = await m.admin("POST", "/v1/admin/agents", { name: "Alex", harness: claude, role: c.role });
    await m.admin("POST", "/v1/admin/agents", { name: c.second[0], harness: codex, role: c.second[1] });
    await m.admin("POST", "/v1/admin/agents", { name: c.third[0], harness: claude, role: c.third[1] });

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
    conn("n1", "telegram", "@alex_hikes_bot", "u1");
    conn("n2", lang === "zh" ? "feishu" : "slack", "Alex", "u1");
    insert(
      "INSERT INTO chats (id, connection_id, platform_id, kind, name, created_at, updated_at) VALUES ('c1','n1','-1','group',?,?,?)",
      c.group,
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
    insert(
      "INSERT INTO tasks (id, agent_id, title, status, created_at, updated_at) VALUES ('t1', ?, ?, 'in_progress', ?, ?)",
      alex.id,
      c.task,
      now,
      now,
    );
    insert(
      "INSERT INTO tasks (id, agent_id, title, status, created_at, updated_at) VALUES ('t2', ?, ?, 'todo', ?, ?)",
      alex.id,
      c.task2,
      now,
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
      ["connect", `/a/${alex.slug}/connect`, 1000, 600],
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
  } finally {
    await m.stop();
  }
}
console.log(`screenshots in ${OUT}`);
