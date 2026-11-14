// Live-browser regression checks for the console, run by scripts/ui-review.mjs on the
// same throwaway Mingle it seeds. Drives headless Chrome over the DevTools protocol
// (no packages) so real coordinate clicks catch what element.click() cannot, e.g. a
// menu clipped by an overflow-hidden card, and checks the side panel's "Manage".
//
// Exports reviewInteractions({ url, token, slug, singleSlug, chrome, out }) and throws
// on any failed assertion. Connection menu triggers are located by their localized
// aria-label rather than new markup, so the checks can also run against older builds.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCALES = {
  "en-US": {
    storage: "en",
    settings: "Settings",
    manage: "Manage",
    more: "More",
    remove: "Remove",
    cancel: "Cancel",
    deleteAgent: "Delete",
    deleteAsk: "Delete ",
    chatApps: "Chat apps",
    install: "Install",
    installing: "Installing",
    notInstalled: "Not installed",
    installFailed: "The installer did not finish",
    retry: "Try again",
    retryMsg: "Retry",
    ignore: "Ignore",
    ignored: "Ignored",
    envTitle: "Environment variables",
    envAdd: "Add",
    activity: "Activity",
    pause: "Pause",
    reset: "Reset",
    resetAsk: "Reset ",
    resetDone: "starts a new session",
    diagCopy: "Copy",
    diagCopied: "Copied",
    diagTitle: "Mingle diagnostic info",
    resume: "Resume",
    paused: "Paused",
    pausedCard: "is paused",
    appLoading: "Loading your agents…",
    activityTitle: "Recent activity",
    activityLoading: "Loading recent activity…",
    activityFailed: "Could not load recent activity",
    noActivity: "No recent activity",
    workTitle: "Tasks and reminders",
    workLoading: "Loading tasks and reminders…",
    workFailed: "Could not load tasks and reminders",
    noTasks: "No tasks.",
    noReminders: "No reminders.",
    connectAction: "Connect a chat app",
    retryLoad: "Retry",
    nameOwner: "Name the owner",
    ownerUnnamed: "Owner not named",
    ownerIs: "Owner: ",
    save: "Save",
  },
  "zh-CN": {
    storage: "zh-CN",
    settings: "设置",
    manage: "管理",
    more: "更多",
    remove: "移除",
    cancel: "取消",
    deleteAgent: "删除",
    deleteAsk: "删除 ",
    chatApps: "聊天软件",
    install: "安装",
    installing: "正在安装",
    notInstalled: "未安装",
    installFailed: "安装没有完成",
    retry: "重试",
    retryMsg: "重试",
    ignore: "忽略",
    ignored: "已忽略",
    envTitle: "环境变量",
    envAdd: "添加",
    activity: "动态",
    pause: "暂停",
    reset: "重置",
    resetAsk: "重置 ",
    resetDone: "已从角色和记忆开始新的会话",
    diagCopy: "复制",
    diagCopied: "已复制",
    diagTitle: "Mingle diagnostic info",
    resume: "恢复",
    paused: "已暂停",
    pausedCard: "已暂停",
    appLoading: "正在加载 Agent…",
    activityTitle: "最近活动",
    activityLoading: "正在加载最近活动…",
    activityFailed: "最近活动加载失败",
    noActivity: "暂无动态",
    workTitle: "任务与提醒",
    workLoading: "正在加载任务与提醒…",
    workFailed: "任务与提醒加载失败",
    noTasks: "没有任务。",
    noReminders: "没有提醒。",
    connectAction: "连接聊天软件",
    retryLoad: "重试",
    nameOwner: "给 owner 起名",
    ownerUnnamed: "owner 未命名",
    ownerIs: "owner：",
    save: "保存",
  },
};

// A window.fetch replacement that mocks only the two fake harnesses used by the
// install-resume scenario; every other request still reaches the real Mingle. The
// fixture lives in sessionStorage so a full page reload keeps the same fake job.
const INSTALL_MOCK = String.raw`(() => {
  const KEY = "mingle.install-review";
  const read = () => JSON.parse(sessionStorage.getItem(KEY) ?? '{"job":null,"installed":false,"starts":0}');
  const write = (s) => sessionStorage.setItem(KEY, JSON.stringify(s));
  const json = (payload, status) =>
    new Response(JSON.stringify(payload), { status: status ?? 200, headers: { "content-type": "application/json" } });
  const brains = (s) => {
    const list = [
      { id: "install-test", name: "Install Test", installed: s.installed, canInstall: true, canSignIn: false },
      { id: "other-test", name: "Other Test", installed: false, canInstall: true, canSignIn: false },
    ];
    if (s.job && s.job.state === "running") list[0].installJob = s.job;
    return list;
  };
  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const path = typeof input === "string" ? input : input.url;
    const method = (init && init.method) || "GET";
    // The console reads the catalog twice: the cached answer, then a fresh probe (?fresh=1).
    if (method === "GET" && /^\/v1\/admin\/brains(\?fresh=1)?$/.test(path)) return Promise.resolve(json(brains(read())));
    if (method === "GET" && path === "/v1/admin/brains/install-test/install-plan")
      return Promise.resolve(
        json({ kind: "plan", steps: ["echo test-install"], source: "https://example.com/install" }),
      );
    if (method === "GET" && path === "/v1/admin/brains/other-test/install-plan")
      return Promise.resolve(json({ kind: "unsupported", detail: "not offered here" }));
    if (method === "GET" && /^\/v1\/admin\/brains\/(install-test|other-test)\/sign-in$/.test(path))
      return Promise.resolve(json({ kind: "unknown" }));
    if (method === "POST" && path === "/v1/admin/brains/install-test/install") {
      const s = read();
      s.starts += 1;
      if (!s.job || s.job.state !== "running") {
        s.job = {
          id: s.starts > 1 ? "j-install-test-" + s.starts : "j-install-test",
          kind: "install",
          harness: "install-test",
          state: "running",
          events: [],
        };
      }
      write(s);
      return Promise.resolve(json(s.job));
    }
    const jobMatch = /^\/v1\/admin\/jobs\/(.+)$/.exec(path);
    if (method === "GET" && jobMatch) {
      const s = read();
      if (s.job && s.job.id === jobMatch[1]) return Promise.resolve(json(s.job));
      return Promise.resolve(json({ error: "job_not_found" }, 404));
    }
    return real(input, init);
  };
})()`;

// A fetch mock for the first status poll: held until the page's own release() defers to
// the real request, so the "loading your agents" state can be checked deterministically.
const STATUS_HOLD = String.raw`(() => {
  const real = window.fetch.bind(window);
  const state = { pending: [] };
  window.__statusHold = state;
  window.fetch = (input, init) => {
    const path = typeof input === "string" ? input : input.url;
    const method = (init && init.method) || "GET";
    if (method === "GET" && /\/v1\/admin\/status(\?|$)/.test(path)) {
      return new Promise((resolve) => state.pending.push(() => resolve(real(input, init))));
    }
    return real(input, init);
  };
  state.release = () => state.pending.splice(0).forEach((f) => f());
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function reviewInteractions({
  url,
  token,
  slug,
  singleSlug,
  envSlug,
  pauseSlug,
  sharedSlug,
  emptySlug,
  envSecret,
  chrome,
  out,
}) {
  const profile = mkdtempSync(join(tmpdir(), "mingle-cdp-"));
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  // Register before any await: a failed spawn (ENOENT) or an early exit must not wait forever.
  let launchError;
  const exited = new Promise((resolve) => {
    child.once("error", (error) => {
      launchError = error;
      resolve();
    });
    child.once("exit", resolve);
  });
  let ws;
  try {
    // Chrome writes the chosen port into the profile once the DevTools server is up.
    const portFile = join(profile, "DevToolsActivePort");
    for (let i = 0; i < 100 && !existsSync(portFile); i++) {
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Chrome exited before DevTools became ready (${child.exitCode ?? child.signalCode})`);
      }
      await sleep(100);
    }
    if (!existsSync(portFile)) throw new Error("DevToolsActivePort never appeared");
    const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("no page target");
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("devtools socket failed"));
    });

    let nextId = 0;
    const pending = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (!msg.id) return;
      const { resolve, reject, timer } = pending.get(msg.id) ?? {};
      if (!resolve) return;
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    };
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, {
          resolve,
          reject,
          timer: setTimeout(() => {
            pending.delete(id);
            reject(new Error(`${method} timed out`));
          }, 15_000),
        });
        ws.send(JSON.stringify({ id, method, params }));
      });

    await send("Page.enable");
    await send("Runtime.enable");
    // The fake-harness mock must exist in every document, full reloads included.
    await send("Page.addScriptToEvaluateOnNewDocument", { source: INSTALL_MOCK });

    // Run a function in the page; page errors and timeouts are real failures.
    const prelude = `const connTriggers=(more)=>[...document.querySelectorAll("button[aria-label]")].filter((b)=>b.getAttribute("aria-label")===more&&!b.closest("header")&&!b.closest("aside"));const brainRow=(name)=>{const el=[...document.querySelectorAll("span.font-medium")].find((s)=>s.textContent.trim()===name);return el?el.closest(".divide-y > *"):null;};`;
    const call = async (fn, ...args) => {
      const { result, exceptionDetails } = await send("Runtime.evaluate", {
        expression: `(()=>{${prelude}return (${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})})()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (exceptionDetails) {
        throw new Error(
          `page evaluation failed: ${exceptionDetails.text} ${exceptionDetails.exception?.description ?? ""}`,
        );
      }
      return result.value;
    };
    const until = async (what, fn, ...args) => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const value = await call(fn, ...args);
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(100);
      }
    };
    const click = async (x, y) => {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      }
    };
    const clickEl = async (found) => {
      if (!found) throw new Error("click target not found");
      await click(found.x, found.y);
    };
    const key = async (k, code, vk, text) => {
      for (const type of ["keyDown", "keyUp"]) {
        await send("Input.dispatchKeyEvent", {
          type,
          key: k,
          code,
          windowsVirtualKeyCode: vk,
          ...(type === "keyDown" && text ? { text, unmodifiedText: text } : {}),
        });
      }
    };
    const metrics = (width, height = 900) =>
      send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    const shot = async (name) => {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(out, `${name}.png`), Buffer.from(data, "base64"));
    };
    const assert = (cond, msg) => {
      if (!cond) throw new Error(`assertion failed: ${msg}`);
    };

    // --- in-page helpers -------------------------------------------------------
    // These are serialized and run inside the page, so they cannot close over anything.
    const centerOfText = (scope, tag, wanted) => {
      const root = document.querySelector(scope);
      if (!root) return null;
      const el = [...root.querySelectorAll(tag)].find((b) => b.textContent.trim() === wanted);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    // Each connection row has a "More" trigger (the header's is excluded); connTriggers
    // comes from the prelude prepended to every evaluation.
    const connCenter = (more, i) => {
      const el = connTriggers(more)[i ?? 0];
      if (!el) return null;
      el.scrollIntoView({ block: "nearest" });
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const connButtonCenter = (more, wanted) => {
      const trigger = connTriggers(more)[0];
      const scope = trigger?.closest("section") ?? document;
      const el = [...scope.querySelectorAll("button")].find((b) => b.textContent.trim() === wanted);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const connHasButton = (more, wanted) => {
      const trigger = connTriggers(more)[0] ?? document.querySelector(`button[aria-label="${more}"]`);
      const scope = trigger?.closest("section") ?? document;
      return [...scope.querySelectorAll("button")].some((b) => b.textContent.trim() === wanted);
    };
    const scrollConn = (more, delta) => {
      const el0 = connTriggers(more)[0];
      if (!el0) return false;
      let el = el0.parentElement;
      while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement;
      if (!el) return false;
      el.scrollTop += delta;
      return true;
    };
    // Settings harness rows: brainRow (in the prelude) finds the row by its exact name.
    const rowHas = (name, wanted) => {
      const row = brainRow(name);
      return !!row && row.textContent.includes(wanted);
    };
    const rowHasButton = (name, wanted) => {
      const row = brainRow(name);
      return !!row && [...row.querySelectorAll("button")].some((b) => b.textContent.trim() === wanted);
    };
    const rowButtonCenter = (name, wanted) => {
      const row = brainRow(name);
      const el = [...(row?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === wanted);
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    };
    const rowSettled = (name, installing, notInstalled, install) => {
      const row = brainRow(name);
      return (
        !!row &&
        !row.textContent.includes(installing) &&
        !row.textContent.includes(notInstalled) &&
        ![...row.querySelectorAll("button")].some((b) => b.textContent.trim() === install)
      );
    };
    const pageFits = () => document.scrollingElement.scrollWidth <= innerWidth;

    // Fixture state for the install mock, kept in sessionStorage so reloads keep it.
    const resetFixture = () =>
      call(() =>
        sessionStorage.setItem("mingle.install-review", JSON.stringify({ job: null, installed: false, starts: 0 })),
      );
    const readFixture = () => call(() => JSON.parse(sessionStorage.getItem("mingle.install-review") ?? "{}"));
    const setFixtureJob = (state, installed) =>
      call(
        (st, inst) => {
          const s = JSON.parse(sessionStorage.getItem("mingle.install-review") ?? "{}");
          if (s.job) s.job = { ...s.job, state: st };
          else s.job = { id: "j-install-test", kind: "install", harness: "install-test", state: st, events: [] };
          if (inst !== undefined) s.installed = inst;
          sessionStorage.setItem("mingle.install-review", JSON.stringify(s));
          return s.job;
        },
        state,
        installed,
      );
    // Move inside the SPA without a reload, as the sidebar does.
    const spaNav = (path) =>
      call((p) => {
        history.pushState(null, "", p);
        dispatchEvent(new PopStateEvent("popstate"));
        return location.pathname;
      }, path);

    const goto = async (path, labels) => {
      await send("Page.navigate", { url: `${url}${path}#token=${token}` });
      await until("page load", () => document.readyState === "complete" && !!document.querySelector("header"));
      await call((locale) => localStorage.setItem("mingle.locale", locale), labels.storage);
      await send("Page.reload");
      await until("app ready", () => !!document.querySelector('header [role="radiogroup"]'));
      // Guard against silent locale fallback: a label must come back translated.
      const found = await until(
        "settings tab label",
        (wanted) =>
          [...document.querySelectorAll('header [role="radio"]')].some((b) => b.textContent.trim() === wanted),
        labels.settings,
      );
      assert(found, `expected "${labels.settings}" tab`);
    };

    const menuInfo = () => {
      const menu = document.querySelector('div[role="menu"]');
      if (!menu) return null;
      const r = menu.getBoundingClientRect();
      return {
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        left: r.left,
        width: r.width,
        height: r.height,
        vw: innerWidth,
        vh: innerHeight,
      };
    };
    const hitTest = (x, y) => {
      const menu = document.querySelector('div[role="menu"]');
      const el = document.elementFromPoint(x, y);
      return !!menu && !!el && (el === menu || menu.contains(el));
    };
    const menuItemCenter = (wanted) => {
      const menu = document.querySelector('div[role="menu"]');
      const el = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])].find((b) => b.textContent.trim() === wanted);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const assertMenuOnScreen = (info, what) => {
      assert(info, `${what}: menu missing`);
      assert(
        info.top >= 0 && info.left >= 0 && info.bottom <= info.vh && info.right <= info.vw,
        `${what}: menu off screen ${JSON.stringify(info)}`,
      );
    };
    const openTriggerMenu = async (more, index) => {
      await clickEl(await call(connCenter, more, index));
      await until("connection menu", () => !!document.querySelector('div[role="menu"]'));
    };
    const menuClosed = () => !document.querySelector('div[role="menu"]');

    const menuScenario = async (localeName, labels, width, tag, count) => {
      const last = count - 1;
      for (const index of [0, last]) {
        const where = index === 0 ? "first" : "last";
        await openTriggerMenu(labels.more, index);
        const info = await call(menuInfo);
        assertMenuOnScreen(info, `${tag} ${where} row`);
        const item = await call(menuItemCenter, labels.remove);
        assert(item, `${tag}: remove item missing`);
        assert(await call(hitTest, item.x, item.y), `${tag} ${where} row: remove item not clickable at its center`);
        // Center alone can survive a clipped tail: the menu's bottom edge must also hit it.
        assert(
          await call(hitTest, (info.left + info.right) / 2, info.bottom - 2),
          `${tag} ${where} row: menu clipped, bottom edge is not clickable`,
        );
        if (index === 0) await shot(`${localeName}-${width}-connmenu-open`);
        await click(item.x, item.y);
        // The row swaps to an inline cancel/remove confirmation; the connection stays.
        await until("remove confirmation", connHasButton, labels.more, labels.cancel);
        if (index === 0) await shot(`${localeName}-${width}-connmenu-confirm`);
        await clickEl(await call(connButtonCenter, labels.more, labels.cancel));
        await until(
          "confirmation dismissed",
          (more, wanted) => {
            const t = connTriggers(more)[0] ?? document.querySelector(`button[aria-label="${more}"]`);
            const scope = t?.closest("section") ?? document;
            return ![...scope.querySelectorAll("button")].some((b) => b.textContent.trim() === wanted);
          },
          labels.more,
          labels.cancel,
        );
        const after = await call((more) => connTriggers(more).length, labels.more);
        assert(after === count, `${tag}: connection lost after cancel (${after} != ${count})`);
      }

      // Escape closes and returns focus to the trigger.
      await openTriggerMenu(labels.more, 0);
      await key("Escape", "Escape", 27);
      await until("menu closed", menuClosed);
      assert(
        await call((more) => document.activeElement === connTriggers(more)[0], labels.more),
        "Escape did not return focus to trigger",
      );

      // A click elsewhere closes.
      await openTriggerMenu(labels.more, 0);
      await clickEl(
        await call((more) => {
          const h2 = connTriggers(more)[0]?.closest("section")?.querySelector("h2");
          const r = h2?.getBoundingClientRect();
          return r?.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
        }, labels.more),
      );
      await until("menu closed by outside click", menuClosed);

      // The trigger toggles.
      await openTriggerMenu(labels.more, 0);
      await clickEl(await call(connCenter, labels.more, 0));
      await until("menu closed by toggle", menuClosed);

      // Scrolling and resizing keep the portal next to its visible trigger.
      await openTriggerMenu(labels.more, 0);
      await call(scrollConn, labels.more, 60);
      await metrics(width - 30);
      await sleep(150);
      const moved = await call((more) => {
        const menu = document.querySelector('div[role="menu"]');
        const trigger = connTriggers(more)[0];
        if (!menu || !trigger) return null;
        const m = menu.getBoundingClientRect();
        const t = trigger.getBoundingClientRect();
        return {
          m: { top: m.top, right: m.right, bottom: m.bottom, left: m.left },
          t: { top: t.top, right: t.right, bottom: t.bottom },
          vw: innerWidth,
          vh: innerHeight,
        };
      }, labels.more);
      assert(moved, "menu lost after scroll/resize");
      assert(
        moved.m.bottom <= moved.vh && moved.m.right <= moved.vw && moved.m.top >= 0 && moved.m.left >= 0,
        "menu off screen after scroll/resize",
      );
      assert(Math.abs(moved.m.right - moved.t.right) < 40, "menu no longer anchored to trigger");
      await metrics(width);
      await key("Escape", "Escape", 27);
      await until("menu closed", menuClosed);
      await call(() => document.activeElement?.blur?.());
    };

    // --- environment variables: list, help, add with a normalized name, a refused name ---
    const envSection = (title) =>
      Boolean(
        [...document.querySelectorAll("section h2")].find((h) => h.textContent.trim() === title)?.closest("section"),
      );
    const envCenter = (title, selector, text) => {
      const section =
        [...document.querySelectorAll("section h2")].find((h) => h.textContent.trim() === title)?.closest("section") ??
        null;
      const el = [...(section?.querySelectorAll(selector) ?? [])].find(
        (e) => text === undefined || e.textContent.trim() === text,
      );
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    };
    const hover = async (found) => {
      if (!found) throw new Error("hover target not found");
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: found.x, y: found.y });
    };
    const envScenario = async (localeName, labels, width) => {
      const tag = `env ${localeName} ${width}`;
      await goto(`/a/${envSlug}`, labels);
      await clickEl(await call(centerOfText, "header", '[role="radio"]', labels.settings));
      await until(
        "env rows",
        (title) => {
          const h = [...document.querySelectorAll("section h2")].find((x) => x.textContent.trim() === title);
          return h?.closest("section")?.textContent.includes("DAILY_WEBHOOK_URL");
        },
        labels.envTitle,
      );
      await call((title) => {
        const h = [...document.querySelectorAll("section h2")].find((x) => x.textContent.trim() === title);
        h?.scrollIntoView({ block: "start" });
      }, labels.envTitle);
      assert(await call(pageFits), `${tag}: page overflows horizontally`);
      assert(!(await call((v) => document.body.innerHTML.includes(v), envSecret)), `${tag}: a value is in the page`);
      await shot(`${localeName}-${width}-env-list`);

      // The "?" explains on hover, inside the window.
      await hover(await call(envCenter, labels.envTitle, "h2 button"));
      const tip = await until("help tooltip", () => {
        const el = document.querySelector('[role="tooltip"]');
        const r = el?.getBoundingClientRect();
        return r?.width ? { left: r.left, right: r.right, vw: innerWidth } : null;
      });
      assert(tip.left >= 0 && tip.right <= tip.vw, `${tag}: tooltip off screen ${JSON.stringify(tip)}`);
      await shot(`${localeName}-${width}-env-help`);
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
      await until("tooltip closed", () => !document.querySelector('[role="tooltip"]'));

      // Add: the typed name becomes a variable name.
      await clickEl(await call(envCenter, labels.envTitle, "button", labels.envAdd));
      await until("env form", () => document.activeElement?.tagName === "INPUT");
      await send("Input.insertText", { text: "daily report-url" });
      const typed = await until("normalized name", () => document.activeElement?.value === "DAILY_REPORT_URL");
      assert(typed, `${tag}: name not normalized`);
      await key("Tab", "Tab", 9);
      await send("Input.insertText", { text: "https://example.test/hook" });
      assert(await call(pageFits), `${tag}: form overflows horizontally`);
      await shot(`${localeName}-${width}-env-form`);

      // A reserved name is refused while typing, before anything is sent.
      await call(() => {
        const input = document.querySelector('form input[autocomplete="off"]');
        input?.focus();
        input?.select();
      });
      await send("Input.insertText", { text: "MINGLE_X" });
      await until("reserved name error", () => !!document.querySelector('form [role="alert"]'));
      assert(
        await call(() => document.querySelector('form button[type="submit"]')?.disabled === true),
        `${tag}: save enabled for a reserved name`,
      );
      await shot(`${localeName}-${width}-env-error`);
      await key("Escape", "Escape", 27);
      await until("form closed", () => !document.querySelector("form"));
      assert(await call(envSection, labels.envTitle), `${tag}: section lost`);
    };

    let passed = 0;
    for (const [localeName, labels] of Object.entries(LOCALES)) {
      for (const width of [1440, 560]) {
        await metrics(width);
        // --- multi-connection agent ---
        await goto(`/a/${slug}`, labels);
        if (width === 1440) {
          // The side panel's Manage lands on the settings connections, focused and in view.
          await clickEl(await call(centerOfText, "aside:not(.sidebar)", "button", labels.manage));
          const state = await until("connections region focused", () => {
            const region = document.querySelector("section[aria-label]");
            if (!region || document.activeElement !== region) return null;
            const r = region.getBoundingClientRect();
            let scroller = region.parentElement;
            while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
            const s = scroller?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight };
            return { top: r.top, viewTop: s.top, viewBottom: s.bottom };
          });
          assert(
            await call(
              (wanted) => document.querySelector("section[aria-label]")?.getAttribute("aria-label") === wanted,
              labels.chatApps,
            ),
            "region aria-label mismatch",
          );
          assert(
            state.top >= state.viewTop - 1 && state.top <= state.viewBottom,
            `region out of view ${JSON.stringify(state)}`,
          );
          const checked = await call(
            (wanted) =>
              [...document.querySelectorAll('header [role="radio"]')]
                .find((b) => b.textContent.trim() === wanted)
                ?.getAttribute("aria-checked"),
            labels.settings,
          );
          assert(checked === "true", "settings tab not selected");
          await shot(`${localeName}-${width}-managed-settings`);

          // Scrolled away and already on settings: Manage scrolls back and refocuses.
          await call(() => {
            const region = document.querySelector("section[aria-label]");
            let scroller = region?.parentElement;
            while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
            if (scroller) scroller.scrollTop = scroller.scrollHeight;
            document.activeElement?.blur?.();
          });
          await clickEl(await call(centerOfText, "aside:not(.sidebar)", "button", labels.manage));
          const again = await until("region back in view", () => {
            const region = document.querySelector("section[aria-label]");
            if (!region || document.activeElement !== region) return null;
            const r = region.getBoundingClientRect();
            let scroller = region.parentElement;
            while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
            const s = scroller?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight };
            return r.top >= s.top - 1 && r.top <= s.bottom ? { top: r.top } : null;
          });
          assert(again, "Manage did not scroll back to connections");

          // A third click, focus elsewhere, must still retrigger.
          await call(() => document.querySelector('header [role="radio"]')?.focus());
          await clickEl(await call(centerOfText, "aside:not(.sidebar)", "button", labels.manage));
          const third = await until(
            "region refocused",
            () => document.activeElement === document.querySelector("section[aria-label]"),
          );
          assert(third, "repeated Manage did not refocus the region");
        } else {
          await clickEl(await call(centerOfText, "header", '[role="radio"]', labels.settings));
        }
        const count = await until("connection rows", (more) => connTriggers(more).length || null, labels.more);
        assert(count === 4, `expected 4 connection rows, got ${count}`);
        await menuScenario(localeName, labels, width, "agent", count);

        assert(
          await call(() => !document.querySelector('header button[aria-haspopup="menu"]')),
          "redundant agent header menu is still present",
        );

        // --- single-connection agent: the reported clipped-menu case ---
        await goto(`/a/${singleSlug}`, labels);
        await clickEl(await call(centerOfText, "header", '[role="radio"]', labels.settings));
        const single = await until("sole connection row", (more) => connTriggers(more).length || null, labels.more);
        assert(single === 1, `expected 1 connection row, got ${single}`);
        await openTriggerMenu(labels.more, 0);
        const sinfo = await call(menuInfo);
        assertMenuOnScreen(sinfo, "single menu");
        const sitem = await call(menuItemCenter, labels.remove);
        assert(await call(hitTest, sitem.x, sitem.y), "single menu item clipped: elementFromPoint misses it");
        assert(
          await call(hitTest, (sinfo.left + sinfo.right) / 2, sinfo.bottom - 2),
          "single menu clipped: bottom edge is not clickable",
        );
        await shot(`${localeName}-${width}-single-menu`);
        await click(sitem.x, sitem.y);
        await until("remove confirmation", connHasButton, labels.more, labels.cancel);
        await clickEl(await call(connButtonCenter, labels.more, labels.cancel));
        await until(
          "confirmation dismissed",
          (more, wanted) => {
            const t = connTriggers(more)[0] ?? document.querySelector(`button[aria-label="${more}"]`);
            const scope = t?.closest("section") ?? document;
            return ![...scope.querySelectorAll("button")].some((b) => b.textContent.trim() === wanted);
          },
          labels.more,
          labels.cancel,
        );
        assert(
          (await call((more) => connTriggers(more).length, labels.more)) === 1,
          "single connection lost after cancel",
        );
        if (envSlug) await envScenario(localeName, labels, width);
        passed++;
        console.log(`interactions ${localeName} ${width}: passed`);
      }
    }

    // --- install resume: a running harness install survives leaving Settings ---
    // The mock (INSTALL_MOCK, injected into every document) answers only for the two
    // fake harnesses; the real Mingle serves everything else. Its sessionStorage
    // fixture survives reloads, so the checks below cover SPA navigation and F5 alike.
    // The settings header is a plain title (no tab radiogroup); the mocked rows are
    // the readiness signal, which also proves the locale took.
    const settingsReady = (labels) => until("settings ready", rowHas, "Other Test", labels.notInstalled);
    const gotoSettings = async (labels) => {
      await send("Page.navigate", { url: `${url}/settings#token=${token}` });
      await until("page load", () => document.readyState === "complete" && !!document.querySelector("header"));
      await call((locale) => localStorage.setItem("mingle.locale", locale), labels.storage);
      await send("Page.reload");
      await settingsReady(labels);
    };

    const installScenario = async (localeName, labels, width) => {
      const tag = `install ${localeName} ${width}`;
      await metrics(width);
      await resetFixture();
      await gotoSettings(labels);
      await until("install row", rowHas, "Install Test", labels.notInstalled);

      // Outer Install opens the plan; its own Install button starts the job.
      await clickEl(await until("outer install button", rowButtonCenter, "Install Test", labels.install));
      await clickEl(await until("confirm install button", rowButtonCenter, "Install Test", labels.install));
      await until("installing", rowHas, "Install Test", labels.installing);
      assert(!(await call(rowHas, "Install Test", labels.notInstalled)), `${tag}: still shows Not installed`);
      assert(!(await call(rowHasButton, "Install Test", labels.install)), `${tag}: install button still shown`);
      assert(await call(rowHas, "Other Test", labels.notInstalled), `${tag}: Other Test lost its row`);
      assert((await readFixture()).starts === 1, `${tag}: installer did not start exactly once`);

      // Leaving Settings to an agent page and coming back keeps the progress.
      await spaNav(`/a/${slug}`);
      await until(
        "agent page replaces settings",
        (path) =>
          location.pathname === path &&
          !brainRow("Install Test") &&
          !!document.querySelector('header [role="radiogroup"]'),
        `/a/${slug}`,
      );
      await spaNav("/settings");
      await until("installing after navigation", rowHas, "Install Test", labels.installing);
      assert(!(await call(rowHas, "Install Test", labels.notInstalled)), `${tag}: nav shows Not installed`);
      assert(!(await call(rowHasButton, "Install Test", labels.install)), `${tag}: nav shows install button`);
      assert((await readFixture()).starts === 1, `${tag}: navigation started a second install`);

      // A full reload must recover the same way: catalog carries installJob, no new POST.
      await send("Page.reload");
      await settingsReady(labels);
      await until("installing after reload", rowHas, "Install Test", labels.installing);
      assert(!(await call(rowHas, "Install Test", labels.notInstalled)), `${tag}: reload shows Not installed`);
      assert(!(await call(rowHasButton, "Install Test", labels.install)), `${tag}: reload shows install button`);
      assert((await readFixture()).starts === 1, `${tag}: reload started a second install`);
      assert(await call(pageFits), `${tag}: horizontal overflow while installing`);
      await shot(`${localeName}-${width}-install-resumed`);

      // Finish: the row settles to installed with no leftover action.
      await setFixtureJob("done", true);
      await until("installed", rowSettled, "Install Test", labels.installing, labels.notInstalled, labels.install);

      // A recovered job can still fail after the binary becomes visible: the catalog
      // already reports installed, but the running job keeps the row on the install path.
      await resetFixture();
      await setFixtureJob("running", true);
      await send("Page.reload");
      await settingsReady(labels);
      await until("installing resumes", rowHas, "Install Test", labels.installing);
      assert(!(await call(rowHas, "Install Test", labels.notInstalled)), `${tag}: installed catalog still wins`);
      assert(!(await call(rowHasButton, "Install Test", labels.install)), `${tag}: running job still owns row`);
      await setFixtureJob("failed");
      await until("failure shown", rowHas, "Install Test", labels.installFailed);
      await until("retry button", rowHasButton, "Install Test", labels.retry);
      assert(await call(pageFits), `${tag}: horizontal overflow on failure`);
      await shot(`${localeName}-${width}-install-failed`);

      // Retry POSTs once; the catalog refresh after done must not POST again.
      await clickEl(await call(rowButtonCenter, "Install Test", labels.retry));
      await until("installing after retry", rowHas, "Install Test", labels.installing);
      assert((await readFixture()).starts === 1, `${tag}: retry POSTed more than once`);
      await setFixtureJob("done", true);
      await until(
        "installed after retry",
        rowSettled,
        "Install Test",
        labels.installing,
        labels.notInstalled,
        labels.install,
      );
      assert((await readFixture()).starts === 1, `${tag}: catalog refresh re-POSTed`);
    };

    for (const [localeName, labels] of Object.entries(LOCALES)) {
      for (const width of [1024, 560]) {
        await installScenario(localeName, labels, width);
        passed++;
        console.log(`install ${localeName} ${width}: passed`);
      }
    }

    // --- pause and resume from the agent's Settings, and back from the card ---
    const buttonByText = (wanted) => {
      const el = [...document.querySelectorAll("main button, button")].find((b) => b.textContent.trim() === wanted);
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    };
    // Settings sections load on their own; a target measured before they land moves under the click.
    const settled = async (what, fn, ...args) => {
      let last = await until(what, fn, ...args);
      for (;;) {
        await sleep(250);
        const now = await until(what, fn, ...args);
        if (now.x === last.x && now.y === last.y) return now;
        last = now;
      }
    };
    const pauseScenario = async (localeName, labels, width) => {
      const tag = `pause ${localeName} ${width}`;
      await metrics(width);
      await goto(`/a/${pauseSlug}`, labels);
      await clickEl(await call(centerOfText, "header", '[role="radio"]', labels.settings));
      await clickEl(await settled("pause button", buttonByText, labels.pause));
      await until("paused status", (p) => document.querySelector("header")?.textContent.includes(p), labels.paused);
      assert(await call(pageFits), `${tag}: horizontal overflow`);
      await shot(`${localeName}-${width}-paused-settings`);
      await clickEl(await call(centerOfText, "header", '[role="radio"]', labels.activity));
      await until(
        "paused card",
        (p) => [...document.querySelectorAll("section h2")].some((h) => h.textContent.includes(p)),
        labels.pausedCard,
      );
      assert(await call(pageFits), `${tag}: horizontal overflow`);
      await shot(`${localeName}-${width}-paused-activity`);
      const auth = { headers: { authorization: `Bearer ${token}` } };
      const paused = (await (await fetch(`${url}/v1/admin/status`, auth)).json()).agents.find(
        (a) => a.slug === pauseSlug,
      );
      assert(paused?.status === "paused", `${tag}: API does not say paused`);
      await clickEl(await until("resume button", buttonByText, labels.resume));
      await until(
        "card gone",
        (r) => ![...document.querySelectorAll("button")].some((b) => b.textContent.trim() === r),
        labels.resume,
      );
      const back = (await (await fetch(`${url}/v1/admin/status`, auth)).json()).agents.find(
        (a) => a.slug === pauseSlug,
      );
      assert(back?.status !== "paused", `${tag}: still paused after resume`);
    };
    for (const [localeName, labels] of Object.entries(LOCALES)) {
      for (const width of [1440, 560]) {
        await pauseScenario(localeName, labels, width);
        passed++;
        console.log(`pause ${localeName} ${width}: passed`);
      }
    }

    // --- reset session (asked in place) and diagnostic info (MING-61) ---
    const resetScenario = async (localeName, labels, width) => {
      const tag = `reset ${localeName} ${width}`;
      await metrics(width);
      await goto(`/a/${pauseSlug}`, labels);
      await clickEl(await call(centerOfText, "header", '[role="radio"]', labels.settings));
      await clickEl(await settled("reset button", buttonByText, labels.reset));
      await until(
        "reset question",
        (ask) =>
          [...document.querySelectorAll("span")].some(
            (s) => (s.textContent.startsWith(ask) && s.textContent.endsWith("?")) || s.textContent.endsWith("？"),
          ),
        labels.resetAsk,
      );
      assert(await call(pageFits), `${tag}: horizontal overflow`);
      await shot(`${localeName}-${width}-reset-confirm`);
      await clickEl(await until("confirm reset", buttonByText, labels.reset));
      await until("reset done", (done) => document.body.textContent.includes(done), labels.resetDone);
      await clickEl(await settled("copy diagnostics", buttonByText, labels.diagCopy));
      // Headless Chrome may refuse the clipboard: then the text shows in place to copy by hand.
      await until(
        "diagnostics copied or shown",
        (copied, title) =>
          [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === copied) ||
          [...document.querySelectorAll("pre")].some((p) => p.textContent.startsWith(title)),
        labels.diagCopied,
        labels.diagTitle,
      );
      assert(await call(pageFits), `${tag}: horizontal overflow`);
      await shot(`${localeName}-${width}-reset-done`);
    };
    for (const [localeName, labels] of Object.entries(LOCALES)) {
      for (const width of [1440, 560]) {
        await resetScenario(localeName, labels, width);
        passed++;
        console.log(`reset ${localeName} ${width}: passed`);
      }
    }

    // --- one agent on two WeChat accounts: name the second owner from its row (MING-55) ---
    const ownerScenario = async (localeName, labels, width) => {
      const tag = `owner ${localeName} ${width}`;
      await metrics(width);
      await goto(`/a/${sharedSlug}`, labels);
      await clickEl(await call(centerOfText, "header", '[role="radio"]', labels.settings));
      const rows = await until("connection rows", (more) => connTriggers(more).length || null, labels.more);
      assert(rows === 2, `${tag}: expected 2 connection rows, got ${rows}`);
      await until("unnamed owner", (u) => document.body.textContent.includes(u), labels.ownerUnnamed);
      assert(await call(pageFits), `${tag}: horizontal overflow`);
      await shot(`${localeName}-${width}-owner-unnamed`);
      await openTriggerMenu(labels.more, 1);
      await clickEl(await call(menuItemCenter, labels.nameOwner));
      await until("name form", () => document.activeElement?.tagName === "INPUT");
      const name = "小美 Mei";
      await send("Input.insertText", { text: name });
      assert(await call(pageFits), `${tag}: form overflows horizontally`);
      await shot(`${localeName}-${width}-owner-form`);
      await clickEl(await until("save button", buttonByText, labels.save));
      await until("owner named", (want) => document.body.textContent.includes(want), `${labels.ownerIs}${name}`);
      await shot(`${localeName}-${width}-owner-named`);
      await clickEl(await call(centerOfText, "header", '[role="radio"]', labels.activity));
      await until(
        "activity shows the name",
        // The activity row's sender, not the side panel, which updates on its own.
        (want) => [...document.querySelectorAll("span.font-semibold")].some((el) => el.textContent.trim() === want),
        name,
      );
      await shot(`${localeName}-${width}-owner-activity`);
      // Back to unnamed for the next run.
      const auth = { headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
      const agent = (await (await fetch(`${url}/v1/admin/status`, auth)).json()).agents.find(
        (a) => a.slug === sharedSlug,
      );
      const contact = agent?.connections.find((c) => c.ownerContact?.name === name)?.ownerContact;
      assert(contact, `${tag}: API does not show the new name`);
      await fetch(`${url}/v1/admin/agents/${agent.id}/contacts/${contact.id}`, {
        method: "PATCH",
        ...auth,
        body: JSON.stringify({ name: "" }),
      });
    };
    for (const [localeName, labels] of Object.entries(LOCALES)) {
      for (const width of [1440, 560]) {
        await ownerScenario(localeName, labels, width);
        passed++;
        console.log(`owner ${localeName} ${width}: passed`);
      }
    }

    // --- deleting an agent asks in its own row, with an explicit safe way out ---
    const deleteScenario = async (localeName, labels, width) => {
      const tag = `delete ${localeName} ${width}`;
      await metrics(width);
      await goto(`/a/${pauseSlug}`, labels);
      await clickEl(await call(centerOfText, "header", '[role="radio"]', labels.settings));
      await call(() => {
        const real = window.fetch.bind(window);
        window.__deleteRequests = [];
        window.__restoreDeleteFetch = () => {
          window.fetch = real;
        };
        window.fetch = (input, init) => {
          const path = typeof input === "string" ? input : input.url;
          const method = init?.method ?? input?.method ?? "GET";
          if (method === "DELETE" && /\/v1\/admin\/agents\/[^/?]+(?:\?|$)/.test(path)) {
            window.__deleteRequests.push(path);
          }
          return real(input, init);
        };
      });
      // The question is a leaf span "Delete <name>?" inside the same row as Cancel.
      const asked = (ask, cancel) => {
        const el = [...document.querySelectorAll("span")].find(
          (s) => s.children.length === 0 && s.textContent.startsWith(ask) && /[?？]$/.test(s.textContent.trim()),
        );
        if (!el) return null;
        const row = el.closest(".divide-y > *");
        const r = el.getBoundingClientRect();
        return {
          inRow: [...(row?.querySelectorAll("button") ?? [])].some((b) => b.textContent.trim() === cancel),
          visible: r.top >= 0 && r.bottom <= window.innerHeight,
          focused: document.activeElement?.textContent.trim() === cancel,
        };
      };
      const gone = (ask) =>
        ![...document.querySelectorAll("span")].some(
          (s) => s.children.length === 0 && s.textContent.startsWith(ask) && /[?？]$/.test(s.textContent.trim()),
        );
      for (const leave of ["cancel", "escape", "enter"]) {
        await clickEl(await settled("delete button", buttonByText, labels.deleteAgent));
        const state = await until("delete question", asked, labels.deleteAsk, labels.cancel);
        assert(state.inRow, `${tag}: the question is not in the delete row`);
        assert(state.visible, `${tag}: the question is out of view`);
        assert(state.focused, `${tag}: focus is not on Cancel`);
        assert(await call(pageFits), `${tag}: horizontal overflow`);
        if (leave === "cancel") {
          await shot(`${localeName}-${width}-delete-confirm`);
          await clickEl(await call(buttonByText, labels.cancel));
        } else if (leave === "escape") {
          await key("Escape", "Escape", 27);
        } else {
          await key("Enter", "Enter", 13, "\r");
        }
        await until("question gone", gone, labels.deleteAsk);
        assert(
          await call((label) => document.activeElement?.textContent.trim() === label, labels.deleteAgent),
          `${tag}: focus did not return to Delete after ${leave}`,
        );
        assert(await call(() => window.__deleteRequests.length === 0), `${tag}: cancel sent a delete request`);
        const auth = { headers: { authorization: `Bearer ${token}` } };
        const still = (await (await fetch(`${url}/v1/admin/status`, auth)).json()).agents.some(
          (a) => a.slug === pauseSlug,
        );
        assert(still, `${tag}: agent gone after ${leave}`);
      }
      await call(() => window.__restoreDeleteFetch());
    };
    for (const [localeName, labels] of Object.entries(LOCALES)) {
      for (const width of [1440, 560]) {
        await deleteScenario(localeName, labels, width);
        passed++;
        console.log(`delete ${localeName} ${width}: passed`);
      }
    }

    // --- empty agent page: loading, failure, empty, and switching agents mid-flight ---
    // The mock's own state lives on the page (window.__emptyReview); it is installed either
    // into the live document or into every new document for a cold-load check.
    const mockEmptyReads = () => {
      const real = window.fetch.bind(window);
      const state = { mode: "hold", pending: [], calls: [] };
      window.__emptyReview = state;
      const reply = (path, mode) =>
        new Response(
          JSON.stringify(
            mode === "fail" ? { error: "http_error" } : path.includes("/activity") ? [] : { tasks: [], reminders: [] },
          ),
          { status: mode === "fail" ? 500 : 200, headers: { "content-type": "application/json" } },
        );
      window.fetch = (input, init) => {
        const path = typeof input === "string" ? input : input.url;
        const method = init?.method || "GET";
        if (method === "GET" && /\/v1\/admin\/agents\/[^/]+\/(activity|work)(\?|$)/.test(path)) {
          state.calls.push(path);
          if (state.mode === "hold") return new Promise((resolve) => state.pending.push({ path, resolve }));
          return Promise.resolve(reply(path, state.mode));
        }
        return real(input, init);
      };
      // Release queued requests whose path contains `part` (all of them without it);
      // later requests answer immediately in `mode`.
      state.release = (mode, part) => {
        state.mode = mode;
        const rest = [];
        for (const p of state.pending.splice(0)) {
          if (part === undefined || p.path.includes(part)) p.resolve(reply(p.path, mode));
          else rest.push(p);
        }
        state.pending = rest;
      };
    };
    const installEmptyMock = () => call(mockEmptyReads);
    const releaseMock = (mode, part) => call((m, p) => window.__emptyReview.release(m, p), mode, part);
    const setMockMode = (mode) =>
      call((m) => {
        window.__emptyReview.mode = m;
      }, mode);
    const mockCalls = () => call(() => window.__emptyReview.calls.length);
    const hasText = (wanted) => document.body.textContent.includes(wanted);
    const bodyHas = (wanted) => call(hasText, wanted);
    // A button inside a <section> titled `title`; a hidden copy (the column that only shows
    // at narrow widths) has an empty rect, so the first visible one wins.
    const buttonInSection = (title, wanted) => {
      const hs = [...document.querySelectorAll("section h2")].filter((h) => h.textContent.trim() === title);
      for (const h of hs) {
        const el = [...(h.closest("section")?.querySelectorAll("button") ?? [])].find(
          (b) => b.textContent.trim() === wanted,
        );
        if (!el) continue;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        if (r.width && r.height) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return null;
    };

    const statusAuth = { headers: { authorization: `Bearer ${token}` } };
    const agentList = (await (await fetch(`${url}/v1/admin/status`, statusAuth)).json()).agents;
    const alexId = agentList.find((a) => a.slug === slug)?.id;
    const emptyId = agentList.find((a) => a.slug === emptySlug)?.id;
    assert(alexId && emptyId, `agent ids not found (${slug}=${alexId}, ${emptySlug}=${emptyId})`);

    const emptyScenario = async (localeName, labels, width) => {
      const tag = `empty ${localeName} ${width}`;
      await metrics(width);
      await goto(`/a/${emptySlug}`, labels);
      // The real thing first: replied long ago, no bot left, nothing to show yet.
      await until("real empty state", hasText, labels.noActivity);
      assert(await bodyHas(labels.noTasks), `${tag}: noTasks missing`);
      assert(await bodyHas(labels.noReminders), `${tag}: noReminders missing`);
      assert(await bodyHas(labels.connectAction), `${tag}: connect action missing`);
      assert(await call(pageFits), `${tag}: horizontal overflow`);
      await shot(`${localeName}-${width}-empty`);

      // Held responses say "loading", and a slow call is not superseded by the next poll.
      // A cold document has nothing cached, so its first reads are the held ones.
      const { identifier } = await send("Page.addScriptToEvaluateOnNewDocument", {
        source: `(${mockEmptyReads.toString()})();`,
      });
      await send("Page.reload");
      await until("activity loading", hasText, labels.activityLoading);
      await until("work loading", hasText, labels.workLoading);
      await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
      assert(!(await bodyHas(labels.noActivity)), `${tag}: empty card during load`);
      assert(!(await bodyHas(labels.noTasks)), `${tag}: noTasks during load`);
      const held = await mockCalls();
      assert(held === 2, `${tag}: expected 2 held requests, got ${held}`);
      await sleep(2700);
      assert((await mockCalls()) === held, `${tag}: polling replaced the held requests`);
      assert(await bodyHas(labels.activityLoading), `${tag}: loading label lost`);
      await shot(`${localeName}-${width}-empty-loading`);

      // A failure explains itself and offers retry: never a silent empty list or a raw code.
      await releaseMock("fail");
      await until("activity failed", hasText, labels.activityFailed);
      await until("work failed", hasText, labels.workFailed);
      assert(!(await bodyHas(labels.noActivity)), `${tag}: empty card on failure`);
      assert(!(await bodyHas(labels.noTasks)), `${tag}: noTasks on failure`);
      assert(!(await bodyHas("http_error")), `${tag}: raw error code rendered`);
      assert(await call(pageFits), `${tag}: horizontal overflow on failure`);
      await shot(`${localeName}-${width}-empty-failed`);

      // Retrying each card lands on the explanatory empty state. Retries are held until the
      // release below, so the poll cannot race the clicks away.
      await setMockMode("hold");
      await clickEl(await until("activity retry", buttonInSection, labels.activityTitle, labels.retryLoad));
      await clickEl(await until("work retry", buttonInSection, labels.workTitle, labels.retryLoad));
      await releaseMock("empty", `/agents/${emptyId}/`);
      await until("activity empty after retry", hasText, labels.noActivity);
      await until("tasks empty after retry", hasText, labels.noTasks);
      await until("reminders empty after retry", hasText, labels.noReminders);
      assert(!(await bodyHas(labels.activityFailed)), `${tag}: activity failure persists`);
      assert(!(await bodyHas(labels.workFailed)), `${tag}: work failure persists`);
      assert(await call(pageFits), `${tag}: horizontal overflow when empty`);
      await shot(`${localeName}-${width}-empty-after-retry`);
      if (width === 1440) {
        await send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "dark" }],
        });
        // The theme transition takes ~120ms; shooting mid-transition captures grey half-tones.
        await sleep(200);
        await shot(`${localeName}-1440-empty-dark`);
        await send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "light" }],
        });
        await sleep(200);
      }

      // The empty card's Connect goes to the connect flow (scoped to the activity section,
      // not the Needs-you panel in the aside).
      await clickEl(await until("connect in empty card", buttonInSection, labels.activityTitle, labels.connectAction));
      await until("connect page", (p) => location.pathname === p, `/a/${emptySlug}/connect`);
      await spaNav(`/a/${emptySlug}`);
      await until("empty restored", hasText, labels.noActivity);

      // Switching agents while requests hang: the previous agent's late failures must not
      // land on the agent now showing. The agent left earlier keeps its (empty) cache, so
      // coming back shows it at once while its fresh reads are the ones held.
      await setMockMode("hold");
      await spaNav(`/a/${slug}`);
      await until("other agent loading", hasText, labels.activityLoading);
      await until("other requests held", (id) => window.__emptyReview.pending.some((p) => p.path.includes(id)), alexId);
      await spaNav(`/a/${emptySlug}`);
      await until("cached empty after switch", hasText, labels.noActivity);
      assert(!(await bodyHas(labels.activityLoading)), `${tag}: cached activity flashed loading`);
      await until(
        "current requests held",
        (id) => window.__emptyReview.pending.filter((p) => p.path.includes(`/agents/${id}/`)).length === 2,
        emptyId,
      );
      assert(!(await bodyHas("@Alex 要带多少水？")), `${tag}: previous agent's activity leaked`);
      assert(!(await bodyHas("比较三条备选路线")), `${tag}: previous agent's task leaked`);
      await releaseMock("fail", `/agents/${alexId}/`);
      await releaseMock("empty", `/agents/${emptyId}/`);
      await call(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await until("empty after switch", hasText, labels.noActivity);
      assert(!(await bodyHas(labels.activityFailed)), `${tag}: activity failure leaked across agents`);
      assert(!(await bodyHas(labels.workFailed)), `${tag}: work failure leaked across agents`);

      // Back to the real API: the populated agent shows real activity and work, and a later
      // transient failure keeps them while explaining itself.
      await send("Page.reload");
      await until("app ready after reload", () => !!document.querySelector('header [role="radiogroup"]'));
      await until("real empty again", hasText, labels.noActivity);
      await spaNav(`/a/${slug}`);
      await until("real activity", hasText, "@Alex 要带多少水？");
      const task = "比较三条备选路线的爬升、距离和交通，周五前给出推荐";
      await until("real task", hasText, task);
      assert(!(await bodyHas(labels.noActivity)), `${tag}: populated agent shows the empty card`);
      await installEmptyMock();
      await setMockMode("fail");
      await until("transient activity failure", hasText, labels.activityFailed);
      await until("transient work failure", hasText, labels.workFailed);
      assert(await bodyHas("@Alex 要带多少水？"), `${tag}: activity lost on transient failure`);
      assert(await bodyHas(task), `${tag}: task lost on transient failure`);
      assert(await call(pageFits), `${tag}: horizontal overflow on transient failure`);
      await shot(`${localeName}-${width}-empty-transient-failed`);
      // Restore the real API for whatever runs next in this document.
      await send("Page.reload");
      await until("real again", () => !!document.querySelector('header [role="radiogroup"]'));
    };

    for (const [localeName, labels] of Object.entries(LOCALES)) {
      for (const width of [1440, 560]) {
        await emptyScenario(localeName, labels, width);
        passed++;
        console.log(`empty ${localeName} ${width}: passed`);
      }
    }

    // --- first paint: a held status request shows "loading", not a blank page ---
    for (const [localeName, labels] of Object.entries(LOCALES)) {
      await metrics(1440);
      const { identifier } = await send("Page.addScriptToEvaluateOnNewDocument", { source: STATUS_HOLD });
      await send("Page.navigate", { url: `${url}/a/${emptySlug}#token=${token}` });
      await until("document ready", () => document.readyState === "complete");
      await call((locale) => localStorage.setItem("mingle.locale", locale), labels.storage);
      await send("Page.reload");
      await until("shell loading", hasText, labels.appLoading);
      assert(!(await call(() => !!document.querySelector("h1"))), "welcome shown before agents load");
      assert(!(await call(() => !!document.querySelector("header"))), "page header shown before status");
      await call(() => window.__statusHold.release());
      await until("header after release", () => !!document.querySelector('header [role="radiogroup"]'));
      await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
      passed++;
      console.log(`loading ${localeName}: passed`);
    }

    // --- ignore: a dismissed message keeps its body but loses its actions ---
    // These run last because they really POST to the seeded Mingle: each message can
    // only be ignored once, so there is one scenario per entrypoint (a single activity
    // row at a narrow width, and the Needs you panel at a wide one).
    const ignoreScenario = async (localeName, labels, width, agentSlug, bodyText, viaNeedsYou) => {
      const tag = `ignore ${localeName} ${width}`;
      await metrics(width);
      await goto(`/a/${agentSlug}`, labels);
      // The activity row holding this exact message body; runs inside the page.
      const buttonInRow = (text, wanted) => {
        const body = [...document.querySelectorAll("p")].find((p) => p.textContent.trim() === text);
        const row = body?.closest("div.px-4");
        const el = [...(row?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === wanted);
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
      };
      const buttonInNeedsYou = (wanted) => {
        const aside = document.querySelector("aside:not(.sidebar)");
        const el = [...(aside?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === wanted);
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
      };
      const target = viaNeedsYou
        ? await until("needs-you ignore button", buttonInNeedsYou, labels.ignore)
        : await until("activity ignore button", buttonInRow, bodyText, labels.ignore);
      await clickEl(target);

      // The same row swaps its actions for a neutral label; the body stays.
      await until(
        "row shows ignored",
        (text, ignored, retryMsg, ignore) => {
          const body = [...document.querySelectorAll("p")].find((p) => p.textContent.trim() === text);
          const row = body?.closest("div.px-4");
          if (!row?.textContent.includes(ignored)) return false;
          const buttons = [...row.querySelectorAll("button")].map((b) => b.textContent.trim());
          return !buttons.includes(retryMsg) && !buttons.includes(ignore);
        },
        bodyText,
        labels.ignored,
        labels.retryMsg,
        labels.ignore,
      );
      assert(await call(pageFits), `${tag}: horizontal overflow`);
      await shot(`${localeName}-${width}-message-ignored`);

      await send("Page.reload");
      await until("app ready after reload", () => !!document.querySelector('header [role="radiogroup"]'));
      await until(
        "ignored survives reload",
        (text, ignored) => {
          const body = [...document.querySelectorAll("p")].find((p) => p.textContent.trim() === text);
          return body?.closest("div.px-4")?.textContent.includes(ignored) ?? false;
        },
        bodyText,
        labels.ignored,
      );

      // The real API agrees: nothing left needing the owner, the record is ignored.
      const auth = { headers: { authorization: `Bearer ${token}` } };
      const summary = await (await fetch(`${url}/v1/admin/summary`, auth)).json();
      const agentSummary = summary.agents.find((a) => a.slug === agentSlug);
      assert(
        agentSummary && agentSummary.failed === 0 && agentSummary.unanswered === 0,
        `${tag}: summary still counts ${JSON.stringify(agentSummary)}`,
      );
      const activity = await (await fetch(`${url}/v1/admin/agents/${agentSlug}/activity`, auth)).json();
      const record = activity.find((m) => m.body === bodyText);
      assert(record?.state === "ignored" && record.triggers, `${tag}: message not ignored ${JSON.stringify(record)}`);
      assert(
        !activity.some((m) => m.state === "failed" || m.state === "unanswered"),
        `${tag}: agent still has retryable messages`,
      );
    };

    await ignoreScenario("en-US", LOCALES["en-US"], 560, slug, "@Alex 要带多少水？", false);
    passed++;
    console.log("ignore en-US 560: passed");
    await ignoreScenario(
      "zh-CN",
      LOCALES["zh-CN"],
      1440,
      singleSlug,
      "Could you summarise this week's article for the club?",
      true,
    );
    passed++;
    console.log("ignore zh-CN 1440: passed");
    console.log(`${passed} interaction scenarios passed`);
  } finally {
    try {
      ws?.close();
    } catch {}
    if (child.exitCode === null && child.signalCode === null && !launchError) child.kill("SIGKILL");
    await exited;
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
