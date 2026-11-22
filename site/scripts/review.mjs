// Screenshots the built site (site/dist) section by section, at desktop and phone widths, light and dark,
// English and Chinese, into .site-review/page/. Reduced motion, so every reveal is already in place.
// Fails if a page scrolls sideways or throws.
//
//   node site/scripts/build.mjs --release <snapshot> && node site/scripts/review.mjs

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DIST = resolve("site/dist");
const OUT = resolve(".site-review/page");
mkdirSync(OUT, { recursive: true });

const types = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
};
const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path.endsWith("/")) path += "index.html";
  try {
    const body = await readFile(join(DIST, path));
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(join(tmpdir(), "demo-review-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  `--user-data-dir=${profile}`,
  "--remote-debugging-port=0",
  "about:blank",
]);
const wsURL = await new Promise((resolve, reject) => {
  let err = "";
  chrome.stderr.on("data", (d) => {
    err += d;
    const m = err.match(/ws:\/\/[^\s]+/);
    if (m) resolve(m[0]);
  });
  chrome.on("exit", () => reject(new Error(`Chrome exited: ${err}`)));
});

const ws = new WebSocket(wsURL);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
const errors = [];
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description);
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
await cdp("Runtime.enable");
await cdp("Page.enable");
const evaluate = async (expression) =>
  (await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const configs = [
  ["en", "/", "light", 1440],
  ["zh", "/zh/", "dark", 1440],
  ["en", "/", "dark", 390],
  ["zh", "/zh/", "light", 390],
  ["en-slack", "/slack/", "light", 1440],
  ["en-github", "/github/", "dark", 1440],
  ["zh-feishu", "/zh/feishu/", "dark", 390],
  ["en-claude-code", "/claude-code/", "light", 1440],
  ["zh-security", "/zh/security/", "dark", 1440],
  ["en-compare", "/compare/", "light", 390],
];

let failed = false;
for (const [lang, path, theme, width] of configs) {
  const tag = `${lang}-${theme}-${width}`;
  await cdp("Emulation.setDeviceMetricsOverride", {
    width,
    height: 900,
    deviceScaleFactor: width < 600 ? 2 : 1,
    mobile: width < 600,
  });
  await cdp("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: theme },
      { name: "prefers-reduced-motion", value: "reduce" },
    ],
  });
  await cdp("Page.navigate", { url: `${origin}${path}` });
  await sleep(1200);
  // Scroll through once so every on-screen trigger has fired.
  await evaluate(
    `(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } scrollTo(0, 0); })()`,
  );
  await sleep(300);
  if (await evaluate(`document.documentElement.scrollWidth > innerWidth`)) {
    console.error(`✗ ${tag}: the page scrolls sideways`);
    failed = true;
  }
  const boxes = await evaluate(`[...document.querySelectorAll("main > section")].map((s, i) => {
    const r = s.getBoundingClientRect();
    return { name: String(i).padStart(2, "0") + "-" + (s.id || s.className.split(" ")[0]), x: 0, y: r.top + scrollY, width: innerWidth, height: r.height };
  })`);
  for (const { name, ...box } of boxes) {
    const { data } = await cdp("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { ...box, height: Math.min(box.height, 4000), scale: 1 },
    });
    writeFileSync(join(OUT, `${tag}-${name}.png`), Buffer.from(data, "base64"));
  }
  console.log(`✓ ${tag} (${boxes.length} sections)`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  failed = true;
}
ws.close();
const exited = new Promise((r) => chrome.once("exit", r));
chrome.kill();
await exited;
server.close();
rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
console.log(`screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
