// Generates static web assets locally via headless Chrome:
//   1. WebP twins for every console screenshot in site/img/*.png (keeps PNGs as fallback)
//   2. Dedicated 1200x630 Open Graph PNG cards in site/img/og/ for social sharing
//
//   node site/scripts/assets.mjs

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { copy } from "./copy.mjs";
import { integrationOrder, integrations } from "./integrations.mjs";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = resolve(import.meta.dirname, "../..");
const SITE = join(ROOT, "site");
const IMG_DIR = join(SITE, "img");
const OG_DIR = join(IMG_DIR, "og");
mkdirSync(OG_DIR, { recursive: true });

const faviconSvg = readFileSync(join(SITE, "favicon.svg"), "utf8");
const platformsSource = readFileSync(join(ROOT, "web/src/platforms.tsx"), "utf8");
const marksSource = platformsSource
  .slice(platformsSource.indexOf("const marks"), platformsSource.indexOf("export function PlatformIcon"))
  .replace(/^const marks:[^=]+=/, "return");
const marks = new Function(marksSource)();

const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function platformIcon(id, size = 56) {
  const mark = marks[id];
  const inner = mark.path
    ? `<svg viewBox="0 0 24 24" width="58%" height="58%" fill="#fff"><path d="${mark.path}"/></svg>`
    : `<svg viewBox="${mark.svg.viewBox}" width="62%" height="62%">${mark.svg.body}</svg>`;
  return `<span style="display:inline-grid;place-items:center;width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.26)}px;background:${mark.color};color:#fff;flex:none;">${inner}</span>`;
}

function ogHtml({ badge, eyebrow, h1, sub, meta, url }) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 1200px;
    height: 630px;
    overflow: hidden;
    background: #ffffff;
    color: #141416;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 1200px;
    height: 630px;
    padding: 64px 76px 56px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    background:
      radial-gradient(900px 420px at 100% 0%, rgba(20, 20, 22, 0.045), transparent 65%),
      linear-gradient(180deg, #ffffff 0%, #f8f8f9 100%);
    border: 1px solid #e6e6e8;
  }
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 14px;
    font-size: 26px;
    font-weight: 700;
    letter-spacing: -0.025em;
    color: #141416;
  }
  .brand svg { width: 40px; height: 40px; display: block; }
  .pill {
    font-size: 18px;
    font-weight: 500;
    color: #5c5c64;
    padding: 8px 18px;
    border-radius: 999px;
    border: 1px solid #e2e2e6;
    background: #ffffff;
  }
  .main {
    display: flex;
    flex-direction: column;
    gap: 20px;
    max-width: 1020px;
  }
  .head-row {
    display: flex;
    align-items: center;
    gap: 18px;
  }
  .eyebrow {
    font-size: 22px;
    font-weight: 600;
    color: #6a6a72;
    letter-spacing: -0.01em;
  }
  h1 {
    font-size: 62px;
    line-height: 1.08;
    font-weight: 700;
    letter-spacing: -0.035em;
    color: #141416;
  }
  h1 span {
    color: #76767f;
  }
  .sub {
    font-size: 25px;
    line-height: 1.45;
    color: #4f4f56;
    max-width: 960px;
  }
  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-top: 24px;
    border-top: 1px solid #e6e6e8;
    font-size: 19px;
    color: #6a6a72;
  }
  .url {
    font-weight: 600;
    color: #141416;
    letter-spacing: -0.01em;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="top">
      <div class="brand">${faviconSvg}<span>Mingle</span></div>
      <div class="pill">MIT · Local-first · Zero server</div>
    </div>
    <div class="main">
      <div class="head-row">${badge || ""}<div class="eyebrow">${esc(eyebrow)}</div></div>
      <h1>${h1}</h1>
      <p class="sub">${esc(sub)}</p>
    </div>
    <div class="foot">
      <span>${esc(meta)}</span>
      <span class="url">${esc(url)}</span>
    </div>
  </div>
</body>
</html>`;
}

const profile = mkdtempSync(join(tmpdir(), "mingle-assets-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  `--user-data-dir=${profile}`,
  "--remote-debugging-port=0",
  "about:blank",
]);
const wsURL = await new Promise((resolvePromise, reject) => {
  let err = "";
  chrome.stderr.on("data", (d) => {
    err += d;
    const m = err.match(/ws:\/\/[^\s]+/);
    if (m) resolvePromise(m[0]);
  });
  chrome.on("exit", () => reject(new Error(`Chrome exited: ${err}`)));
});

const ws = new WebSocket(wsURL);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let rpcId = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve: res, reject: rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((res, rej) => {
    const n = ++rpcId;
    pending.set(n, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id: n, method, params, sessionId }));
  });

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const cdp = (method, params) => send(method, params, sessionId);
await cdp("Page.enable");
await cdp("Runtime.enable");

// 1. Convert site/img/*.png -> site/img/*.webp
const pngs = readdirSync(IMG_DIR)
  .filter((f) => f.endsWith(".png"))
  .sort();
let totalPng = 0;
let totalWebp = 0;
for (const file of pngs) {
  const pngPath = join(IMG_DIR, file);
  const webpPath = join(IMG_DIR, `${basename(file, ".png")}.webp`);
  const dataUri = `data:image/png;base64,${readFileSync(pngPath).toString("base64")}`;
  const { result } = await cdp("Runtime.evaluate", {
    expression: `(async () => {
      const img = new Image();
      img.src = ${JSON.stringify(dataUri)};
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      return canvas.toDataURL("image/webp", 0.86).split(",")[1];
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  writeFileSync(webpPath, Buffer.from(result.value, "base64"));
  const pngSize = statSync(pngPath).size;
  const webpSize = statSync(webpPath).size;
  totalPng += pngSize;
  totalWebp += webpSize;
}
console.log(
  `webp: ${pngs.length} images ${(totalPng / 1024).toFixed(0)} KB -> ${(totalWebp / 1024).toFixed(0)} KB (-${Math.round((1 - totalWebp / totalPng) * 100)}%)`,
);

// 2. Render 1200x630 Open Graph cards
await cdp("Emulation.setDeviceMetricsOverride", {
  width: 1200,
  height: 630,
  deviceScaleFactor: 1,
  mobile: false,
});

const cards = [
  {
    file: "home-en.png",
    badge: "",
    eyebrow: "Claude Code · Codex · OpenCode · Kimi Code + 10 more",
    h1: copy.en.hero.title,
    sub: "Bring your local coding agent into Slack, Discord, Telegram, WeChat, Feishu, GitHub & iMessage. One memory, no server.",
    meta: "macOS · Windows · Linux · OS Keychain credentials",
    url: "mingle.build",
  },
  {
    file: "home-zh.png",
    badge: "",
    eyebrow: "Claude Code · Codex · OpenCode · Kimi Code 等 14 款 Harness",
    h1: copy.zh.hero.title,
    sub: "把本机 coding agent 请进微信、飞书、企业微信、钉钉、QQ、Slack、Discord、Telegram、GitHub 与 iMessage。本地运行，没有服务器。",
    meta: "macOS · Windows · Linux · 系统钥匙串保存凭据",
    url: "mingle.build/zh/",
  },
];

for (const lang of ["en", "zh"]) {
  for (const id of integrationOrder) {
    const g = integrations[lang][id];
    cards.push({
      file: `${id}-${lang}.png`,
      badge: platformIcon(id, 54),
      eyebrow: g.eyebrow,
      h1: g.h1,
      sub: g.lead,
      meta: g.transportNote,
      url: lang === "en" ? `mingle.build/${id}/` : `mingle.build/zh/${id}/`,
    });
  }
}

for (const card of cards) {
  await cdp("Page.setDocumentContent", {
    frameId: targetId,
    html: ogHtml(card),
  });
  await cdp("Runtime.evaluate", {
    expression: "document.fonts ? document.fonts.ready : Promise.resolve()",
    awaitPromise: true,
  });
  const { data } = await cdp("Page.captureScreenshot", {
    format: "png",
    clip: { x: 0, y: 0, width: 1200, height: 630, scale: 1 },
  });
  writeFileSync(join(OG_DIR, card.file), Buffer.from(data, "base64"));
}
console.log(`og: ${cards.length} cards in ${OG_DIR}`);

ws.close();
const exited = new Promise((r) => chrome.once("exit", r));
chrome.kill();
await exited;
rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
