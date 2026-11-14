// Plays every scene of the homepage demo in headless Chrome, tapping Send whenever it's the visitor's turn,
// and screenshots each finished scene (plus a few frames mid-scene) into .site-review/demo/.
//
//   node site/scripts/build.mjs --release <snapshot> && node site/scripts/demo-review.mjs [--motion]
//
// Without --motion it runs with reduced motion (fast) in en/zh × light/dark × desktop/phone.
// With --motion it plays English, light, at full speed, and also shoots the live reply while it works.
// Fails if a scene doesn't reach its end, or the page throws.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DIST = resolve("site/dist");
const OUT = resolve(".site-review/demo");
const motion = process.argv.includes("--motion");
mkdirSync(OUT, { recursive: true });

const types = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
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

async function shoot(name) {
  const box =
    await evaluate(`(() => { const r = document.querySelector(innerWidth < 600 ? "#demo .demo-stage" : "#demo .demo-grid").getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: Math.min(r.height, 1400) }; })()`);
  const { data } = await cdp("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { ...box, scale: 1 },
  });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
}

const configs = motion
  ? [["en", "/", "light", 1280]]
  : [
      ["en", "/", "light", 1280],
      ["en", "/", "dark", 1280],
      ["zh", "/zh/", "light", 1280],
      ["zh", "/zh/", "dark", 1280],
      ["en", "/", "dark", 390],
      ["zh", "/zh/", "light", 390],
    ];

let failed = false;
for (const [lang, path, theme, width] of configs) {
  const mobile = width < 600;
  await cdp("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 2, mobile });
  await cdp("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: theme },
      { name: "prefers-reduced-motion", value: motion ? "no-preference" : "reduce" },
    ],
  });
  await cdp("Page.navigate", { url: `${origin}${path}` });
  await sleep(800);
  await evaluate(`document.getElementById("demo").scrollIntoView(); true`);
  if (await evaluate(`document.documentElement.scrollWidth > innerWidth`)) {
    console.error(`✗ ${lang}-${theme}-${width}: the page scrolls sideways`);
    failed = true;
  }
  const count = await evaluate(`document.querySelectorAll("[data-scene]").length`);
  for (let i = 0; i < count; i++) {
    const tag = `${lang}-${theme}-${width}-${i + 1}`;
    await evaluate(`document.querySelectorAll("[data-scene]")[${i}].click(); true`);
    const deadline = Date.now() + (motion ? 90_000 : 15_000);
    let sends = 0;
    let frames = 0;
    for (;;) {
      await sleep(motion ? 250 : 60);
      const state = await evaluate(`(() => {
        const p = document.querySelector("#demo .phone");
        return { done: !p.querySelector(".demo-end").hidden, turn: !p.querySelector(".im-send").disabled,
          live: !!p.querySelector(".im-log:not([hidden]) .steps li.shown") };
      })()`);
      if (state.done) break;
      if (motion && state.live && frames < 1) {
        await shoot(`${tag}-working`);
        frames++;
      }
      if (state.turn) {
        if (sends === 0) await shoot(`${tag}-turn`);
        await evaluate(`document.querySelector("#demo .im-send").click(); true`);
        sends++;
      }
      if (Date.now() > deadline) {
        console.error(`✗ ${tag}: did not finish`);
        failed = true;
        break;
      }
    }
    await shoot(tag);
    console.log(`✓ ${tag} (${sends} send${sends === 1 ? "" : "s"})`);
  }
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
