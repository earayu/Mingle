// Screenshot the console with awkward content at several widths and in both languages.
//
//   pnpm build && pnpm ui:review        → .ui-review/*.png
//
// Starts a throwaway Mingle (its own MINGLE_HOME), seeds long names, long text and
// every connection state, then renders each page with headless Chrome. Look at every
// image before shipping a console change.

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const run = promisify(execFile);
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = resolve(".ui-review");
const PORT = 7490 + Math.floor(Math.random() * 100);
// Desktop Chrome will not lay out narrower than 500 px, so smaller widths only crop the image.
const WIDTHS = (process.env.WIDTHS ?? "1440,1024,760,560").split(",").map(Number);
const LOCALES = ["en-US", "zh-CN"];

const home = mkdtempSync(join(tmpdir(), "mingle-ui-"));
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const daemon = spawn(process.execPath, ["dist/cli/main.js", "start", "--port", String(PORT), "--no-open"], {
  env: { ...process.env, MINGLE_HOME: home },
  stdio: "ignore",
});

try {
  const runtimePath = join(home, "runtime.json");
  for (let i = 0; i < 80 && !existsSync(runtimePath); i++) await new Promise((r) => setTimeout(r, 100));
  const { url, adminToken } = JSON.parse(readFileSync(runtimePath, "utf8"));
  const admin = async (method, path, body) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return response.json();
  };

  const harness = (await admin("GET", "/v1/admin/harnesses"))[0]?.id ?? "claude";
  const alex = await admin("POST", "/v1/admin/agents", {
    name: "Alex",
    harness,
    role: "帮我们的周末徒步群规划路线、查天气，并在周五晚上提醒大家集合时间。Keep replies short and friendly; answer in the language people write in.",
  });
  const long = await admin("POST", "/v1/admin/agents", {
    name: "Wilhelmina Montgomery-Fairbanks III",
    harness,
    role:
      "A".repeat(0) +
      "Research assistant for the reading club. Summarises long articles, keeps a running list of recommended books with short reviews, answers questions about previous discussions, and posts a weekly digest every Sunday evening.",
  });
  await admin("POST", "/v1/admin/agents", { name: "小助手", harness, role: "" });

  // Seed chats and history straight into the database.
  const db = new DatabaseSync(join(home, "mingle.db"));
  const now = Date.now();
  const insert = (sql, ...args) => db.prepare(sql).run(...args);
  const conn = (id, agent, platform, bot, state, detail, owner) =>
    insert(
      "INSERT INTO connections (id, agent_id, platform, bot_id, bot_name, state, state_detail, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      agent,
      platform,
      id,
      bot,
      state,
      detail,
      owner,
      now,
      now,
    );
  conn("n1", alex.id, "telegram", "@alex_weekend_hiking_helper_bot", "connected", null, "u1");
  conn("n2", alex.id, "feishu", "Alex 徒步助手", "awaiting_approval", null, null);
  conn("n3", alex.id, "slack", "alex", "error", "credentials_revoked", "u9");
  conn("n4", long.id, "discord", "Wilhelmina#4242", "connected", null, null);
  insert(
    "INSERT INTO chats (id, connection_id, platform_id, kind, name, created_at, updated_at) VALUES ('c1','n1','-1','group','周末徒步 · 北京西山与香山常走路线交流群',?,?)",
    now,
    now,
  );
  insert(
    "INSERT INTO chats (id, connection_id, platform_id, kind, name, created_at, updated_at) VALUES ('c2','n1','7','dm','Zhang San',?,?)",
    now,
    now,
  );
  const msg = (id, chat, dir, sender, body, state, ago, attachments = null) =>
    insert(
      "INSERT INTO messages (id, chat_id, direction, platform_id, sender_id, sender_name, body, attachments, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      chat,
      dir,
      id,
      sender ? "u" : null,
      sender,
      body,
      attachments,
      state,
      now - ago,
    );
  msg("m01", "c1", "in", "张三", "@Alex 周六去香山那条线，天气怎么样？", "replied", 3_600_000);
  msg(
    "m02",
    "c1",
    "out",
    null,
    "周六晴，8–17℃，上午风小，适合走香山北线。下午两点后西北风会大一些，建议中午前下山。",
    "sent",
    3_500_000,
  );
  msg(
    "m03",
    "c2",
    "in",
    "Zhang San",
    "Can you put together a packing list for a 12 km hike with about 600 m of climbing, for someone who has not hiked much before, including food and water and what to do if the weather turns?",
    "replied",
    1_800_000,
  );
  msg(
    "m04",
    "c2",
    "out",
    null,
    "Here is a list:\n1. 2 L water\n2. Snacks\n3. Rain shell\n4. Headlamp\nhttps://example.com/a-very-long-link-to-a-packing-guide-that-should-not-break-the-layout-of-the-activity-list/section/4",
    "sent",
    1_700_000,
  );
  msg(
    "m05",
    "c1",
    "in",
    "Maximiliana Alexandrovna Konstantinopolskaya",
    "@Alex 要带多少水？",
    "unanswered",
    120_000,
    JSON.stringify([{ id: "f1", ref: "x", name: "route-map-xiangshan-north-loop-final-v3.gpx" }]),
  );
  insert(
    "INSERT INTO tasks (id, agent_id, title, status, created_at, updated_at) VALUES ('t1', ?, '比较三条备选路线的爬升、距离和交通，周五前给出推荐', 'in_progress', ?, ?)",
    alex.id,
    now,
    now,
  );
  insert(
    "INSERT INTO tasks (id, agent_id, title, status, created_at, updated_at) VALUES ('t2', ?, 'Book the minibus', 'todo', ?, ?)",
    alex.id,
    now,
    now,
  );
  insert(
    "INSERT INTO reminders (id, agent_id, body, rule, timezone, next_fire_at, created_at) VALUES ('r1', ?, '在群里提醒周六 7:30 香山公园北门集合，并确认人数', 'once', 'Asia/Shanghai', ?, ?)",
    alex.id,
    now + 86_400_000,
    now,
  );
  insert(
    "UPDATE agents SET status = 'working', status_detail = 'Bash: curl -s https://api.weather.example/forecast?lat=39.99&lon=116.19' WHERE id = ?",
    alex.id,
  );
  insert(
    "UPDATE agents SET status = 'error', status_detail = 'the harness refused the input (busy: another turn is running)' WHERE id = ?",
    long.id,
  );
  db.close();

  const pages = [
    ["agent", `/a/${alex.slug}`],
    ["long", `/a/${long.slug}`],
    ["new", "/new"],
    ["home", "/"],
    ["menu", `/a/${alex.slug}?menu=1`],
  ];
  const jobs = [];
  for (const locale of LOCALES) {
    for (const width of WIDTHS) {
      for (const [name, path] of pages) {
        const file = join(OUT, `${locale}-${width}-${name}.png`);
        const profile = mkdtempSync(join(tmpdir(), "mingle-chrome-"));
        jobs.push(
          run(CHROME, [
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            `--user-data-dir=${profile}`,
            `--lang=${locale}`,
            `--accept-lang=${locale}`,
            `--window-size=${width},1600`,
            "--virtual-time-budget=5000",
            `--screenshot=${file}`,
            `${url}${path}#token=${adminToken}`,
          ]).finally(() => rmSync(profile, { recursive: true, force: true })),
        );
      }
    }
  }
  for (let i = 0; i < jobs.length; i += 4) await Promise.all(jobs.slice(i, i + 4));
  console.log(`${jobs.length} screenshots in ${OUT}`);
} finally {
  daemon.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  rmSync(home, { recursive: true, force: true });
}
