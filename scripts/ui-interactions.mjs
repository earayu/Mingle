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

import { REMOTE_MOCK } from "./ui-remote.mjs";

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
    updateTo: "Update to 1.1.0",
    installing: "Installing",
    notInstalled: "Not installed",
    installFailed: "The installer did not finish",
    retry: "Try again",
    retryMsg: "Retry",
    ignore: "Ignore",
    ignored: "Ignored",
    envTitle: "Environment variables",
    profileTitle: "Name and picture",
    envAdd: "Add",
    activity: "Activity",
    pause: "Pause",
    closeTask: "Close task: ",
    closeTaskYes: "Close task",
    cancelReminder: "Cancel reminder: ",
    cancelReminderYes: "Cancel reminder",
    reset: "Reset",
    resetAsk: "Reset ",
    resetDone: "session has been cleared",
    diagCopy: "Copy",
    diagCopied: "Copied",
    diagTitle: "Mingle (https://github.com/earayu/Mingle)",
    resume: "Resume",
    handoffTitle: "Handoff",
    handoffOpen: "Hand off",
    handoffCopy: "Copy",
    handoffPaste: "Paste",
    handoffSend: "Hand to Alex",
    handoffWaiting: "Waiting for that conversation to run the command",
    handoffCopyFailed: "Could not copy. Select the prompt and copy it yourself.",
    handoffFeed: "You handed Alex a handoff",
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
    contactsTitle: "Contacts",
    allMe: "Are these all you?",
    ownerUnnamed: "Owner not named",
    ownerIs: "Owner: ",
    save: "Save",
    roleTitle: "Role",
    edit: "Edit",
    roleSaved: "Saved. It applies from the next message.",
    navMenu: "Agents and settings",
    showMore: (n) => `Show ${n} more`,
    showLess: "Show less",
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
    updateTo: "更新到 1.1.0",
    installing: "正在安装",
    notInstalled: "未安装",
    installFailed: "安装没有完成",
    retry: "重试",
    retryMsg: "重试",
    ignore: "忽略",
    ignored: "已忽略",
    envTitle: "环境变量",
    profileTitle: "名字和头像",
    envAdd: "添加",
    activity: "动态",
    pause: "暂停",
    closeTask: "关闭任务：",
    closeTaskYes: "关闭任务",
    cancelReminder: "取消提醒：",
    cancelReminderYes: "取消提醒",
    reset: "重置",
    resetAsk: "重置 ",
    resetDone: "的会话已清除",
    diagCopy: "复制",
    diagCopied: "已复制",
    diagTitle: "Mingle (https://github.com/earayu/Mingle)",
    resume: "恢复",
    handoffTitle: "交接",
    handoffOpen: "交接",
    handoffCopy: "复制",
    handoffPaste: "粘贴内容",
    handoffSend: "交给 Alex",
    handoffWaiting: "等待那段对话运行命令",
    handoffCopyFailed: "没能复制，请选中提示词自己复制。",
    handoffFeed: "你交给 Alex 一份交接",
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
    contactsTitle: "联系人",
    allMe: "这些都是你吗？",
    ownerUnnamed: "owner 未命名",
    ownerIs: "owner：",
    save: "保存",
    roleTitle: "角色",
    edit: "编辑",
    roleSaved: "已保存，从下一条消息起生效。",
    navMenu: "Agent 与设置",
    showMore: (n) => `展开其余 ${n} 个`,
    showLess: "收起",
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
      { id: "update-test", name: "Update Test", installed: true, version: "1.0.0", canInstall: false, canSignIn: false, canUpdate: true },
    ];
    if (s.many) {
      list.push(
        { id: "extra-1", name: "Extra Installed 1", installed: true, version: "1.0.0", canInstall: false, canSignIn: false },
        { id: "extra-2", name: "Extra Installed 2", installed: true, version: "1.0.0", canInstall: false, canSignIn: false },
        { id: "extra-3", name: "Extra Installed 3", installed: true, version: "1.0.0", canInstall: false, canSignIn: false },
        { id: "extra-4", name: "Extra Installed 4", installed: true, version: "1.0.0", canInstall: false, canSignIn: false },
        { id: "extra-5", name: "Extra Uninstalled 1", installed: false, canInstall: true, canSignIn: false },
        { id: "extra-6", name: "Extra Uninstalled 2", installed: false, canInstall: true, canSignIn: false },
        { id: "extra-7", name: "Extra Uninstalled 3", installed: false, canInstall: true, canSignIn: false },
      );
    }
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
    if (method === "GET" && path === "/v1/admin/brains/update-test/update")
      return Promise.resolve(json({ kind: "available", installed: "1.0.0", latest: "1.1.0" }));
    if (method === "GET" && /^\/v1\/admin\/brains\/(install-test|other-test|update-test|extra-\d+)\/(sign-in|update|usage)$/.test(path))
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

// The Feishu bot (n2) as if it were online, with its permissions and a few contacts, while
// sessionStorage "mingle.permissions-review" is set: the permission rows read the platform
// live, which this throwaway Mingle has no connection for. Everything else is real.
const PERMISSIONS_MOCK = String.raw`(() => {
  const on = () => sessionStorage.getItem("mingle.permissions-review");
  const json = (payload) => new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const path = typeof input === "string" ? input : input.url;
    const method = (init && init.method) || "GET";
    if (!on() || method !== "GET") return real(input, init);
    if (path === "/v1/admin/connections/n2/permissions")
      return json({
        permissions: [
          { id: "group_messages", granted: on() !== "several" },
          { id: "bot_messages", granted: true },
          { id: "member_profiles", granted: on() === "granted", optional: true },
        ],
      });
    if (path === "/v1/admin/status" || /^\/v1\/admin\/agents\/[^/]+\/contacts$/.test(path)) {
      const body = await (await real(input, init)).json();
      if (path === "/v1/admin/status") {
        for (const agent of body.agents)
          for (const c of agent.connections) if (c.id === "n2") Object.assign(c, { state: "connected", detail: null, owner: "ou_owner" });
        return json(body);
      }
      const account = (id, name, profile, bot) => ({
        id, platform: "feishu", connection: "n2", name, platformName: name, owner: false, access: null,
        ownerShared: false, bot, linkedBy: null, profile,
      });
      body.push(
        { person: null, name: "应珊珊", note: null, accounts: [account("uys1", "应珊珊", "KubeBlocks Enterprise 产品部, 平台与基础设施组 · 高级产品经理", false)] },
        { person: null, name: "Thomas the Coder", note: null, accounts: [account("utc1", "Thomas the Coder", null, true)] },
      );
      return json(body);
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
    await send("Page.addScriptToEvaluateOnNewDocument", { source: REMOTE_MOCK });
    await send("Page.addScriptToEvaluateOnNewDocument", { source: PERMISSIONS_MOCK });

    // Run a function in the page; page errors and timeouts are real failures.
    const prelude = `const connTriggers=(more)=>[...document.querySelectorAll("button[aria-label]")].filter((b)=>b.getAttribute("aria-label")===more&&!b.closest("header")&&!b.closest("aside")&&b.closest('[id^="connection-"]'));const brainRow=(name)=>{const el=[...document.querySelectorAll("span.font-medium")].find((s)=>s.textContent.trim()===name);return el?el.closest(".divide-y > *"):null;};`;
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
      // A long "Needs you" can push it below the fold: a click there would land on nothing.
      el.scrollIntoView({ block: "nearest" });
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
      const trigger = connTriggers(more)[0] ?? document.querySelector('[id^="connection-"]');
      const scope = trigger?.closest("section") ?? document;
      const el = [...scope.querySelectorAll("button")].find((b) => b.textContent.trim() === wanted);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const connHasButton = (more, wanted) => {
      // While it asks, the row has no menu: the bot's row on its page is the scope.
      const trigger = connTriggers(more)[0] ?? document.querySelector('[id^="connection-"]');
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
    // Settings lists the bots as rows that open each bot's own page (chat-app-<id>).
    const chatAppRows = () => document.querySelectorAll('[id^="chat-app-"]').length;
    const chatAppRowCenter = (i) => {
      const el = document.querySelectorAll('[id^="chat-app-"]')[i];
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    };
    const backCenter = (label) => {
      const el = [...document.querySelectorAll("nav button")].find((b) => b.textContent.trim() === label);
      if (!el) return null;
      el.scrollIntoView({ block: "nearest" });
      const r = el.getBoundingClientRect();
      return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    };
    /** Open the i-th bot's page from the settings list; it shows that one bot. */
    const openBot = async (i, labels) => {
      await until("chat app rows", chatAppRows);
      await clickEl(await settled("chat app row", chatAppRowCenter, i));
      await until("bot page", (more) => connTriggers(more).length === 1 || null, labels.more);
    };
    const backToList = async (labels) => {
      await clickEl(await until("back button", backCenter, labels.settings));
      await until("settings list", chatAppRows);
    };

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
            const t = connTriggers(more)[0] ?? document.querySelector('[id^="connection-"]');
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
          const h2 =
            connTriggers(more)[0]?.closest("section")?.querySelector("h2") ??
            [...document.querySelectorAll("section h2")].find((h) => !h.closest("aside"));
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

    // --- name and picture: choose an image, frame it in place, save it (MING-73) ---
    // Alex's seeded picture is the file to choose: the review needs no image of its own.
    const picture = join(mkdtempSync(join(tmpdir(), "mingle-picture-")), "picture.png");
    {
      const auth = { authorization: `Bearer ${token}` };
      const alex = await (await fetch(`${url}/v1/admin/agents/${slug}`, { headers: auth })).json();
      if (alex.avatar) writeFileSync(picture, Buffer.from(await (await fetch(`${url}${alex.avatar}`)).arrayBuffer()));
    }
    const profileScenario = async (localeName, labels, width) => {
      const tag = `profile ${localeName} ${width}`;
      await goto(`/a/${envSlug}`, labels);
      await clickEl(await call(centerOfText, "header", '[role="radio"]', labels.settings));
      await until("profile section", envSection, labels.profileTitle);
      await call(() => document.querySelector("main, .overflow-y-auto")?.scrollTo?.(0, 0));
      assert(await call(pageFits), `${tag}: page overflows horizontally`);
      await shot(`${localeName}-${width}-profile`);
      if (!existsSync(picture)) return;
      const before = await call(() => document.querySelector("header img")?.getAttribute("src") ?? null);

      // Choosing a file opens the framing in place, with no dialog.
      const { root } = await send("DOM.getDocument", { depth: -1 });
      const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: 'input[type="file"]' });
      await send("DOM.setFileInputFiles", { nodeId, files: [picture] });
      await until("crop stage", () => !!document.querySelector('[role="slider"]'));
      assert(!(await call(() => !!document.querySelector('[role="dialog"]'))), `${tag}: framing opened a dialog`);
      // The keyboard zooms the framing.
      await call(() => document.querySelector('[role="slider"]')?.focus());
      for (let i = 0; i < 4; i++) await key("+", "Equal", 187, "+");
      const zoom = await call(() => Number(document.querySelector('[role="slider"]')?.getAttribute("aria-valuenow")));
      assert(zoom > 100, `${tag}: + did not zoom (${zoom})`);
      assert(await call(pageFits), `${tag}: framing overflows horizontally`);
      await shot(`${localeName}-${width}-profile-crop`);

      await clickEl(await call(envCenter, labels.profileTitle, "button", labels.save));
      const after = await until(
        "new picture in the header",
        (old) => {
          const src = document.querySelector("header img")?.getAttribute("src");
          return !document.querySelector('[role="slider"]') && src && src !== old ? src : null;
        },
        before,
      );
      assert(after.startsWith("/v1/avatars/"), `${tag}: header picture is ${after}`);
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

          // Settings already lists the bots with their controls: the side panel does not repeat them.
          assert(
            await call(
              (wanted) =>
                ![...document.querySelectorAll("aside:not(.sidebar) h2, aside:not(.sidebar) h3")].some(
                  (h) => h.textContent.trim() === wanted,
                ),
              labels.chatApps,
            ),
            "side panel repeats the chat apps on settings",
          );

          // Back on activity, a bot's row in the side panel opens that bot's own page in settings,
          // at its top. Scroll settings away first so the landing is real.
          await call(() => {
            const region = document.querySelector("section[aria-label]");
            let scroller = region?.parentElement;
            while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
            if (scroller) scroller.scrollTop = scroller.scrollHeight;
          });
          await clickEl(await call(centerOfText, "header", '[role="radio"]', labels.activity));
          const rowCenter = await until(
            "side panel bot rows",
            (wanted) => {
              const section = [...document.querySelectorAll("aside:not(.sidebar) section")].find(
                (el) => el.querySelector("h2")?.textContent.trim() === wanted,
              );
              const rows = [...(section?.querySelectorAll(".divide-y > button") ?? [])];
              const row = rows.at(-1);
              if (!row) return null;
              row.scrollIntoView({ block: "nearest" });
              const r = row.getBoundingClientRect();
              return r.width
                ? {
                    x: r.left + r.width / 2,
                    y: r.top + r.height / 2,
                    count: rows.length,
                    name: row.querySelector(".truncate")?.textContent.trim() ?? "",
                  }
                : null;
            },
            labels.chatApps,
          );
          assert(rowCenter.count >= 2, `expected bot rows in the side panel, got ${rowCenter.count}`);
          await clickEl(rowCenter);
          const opened = await until(
            "bot page",
            (more) => {
              const triggers = connTriggers(more);
              if (triggers.length !== 1) return null;
              const row = triggers[0].closest('[id^="connection-"]');
              let scroller = row?.parentElement;
              while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
              return {
                name: row?.querySelector(".font-medium")?.textContent.trim() ?? "",
                top: scroller?.scrollTop ?? 0,
              };
            },
            labels.more,
          );
          assert(rowCenter.name.startsWith(opened.name), `opened ${opened.name}, clicked ${rowCenter.name}`);
          assert(opened.top === 0, `bot page opened scrolled to ${opened.top}`);
          assert(await call(pageFits), "bot page overflows horizontally");
          await shot(`${localeName}-${width}-opened-bot`);
          // Back lands on that bot's row in the list.
          await backToList(labels);
          const focused = await until("bot row focused", () => {
            const el = document.activeElement;
            if (!el?.id?.startsWith("chat-app-")) return null;
            const rows = [...document.querySelectorAll('[id^="chat-app-"]')];
            return { index: rows.indexOf(el), rows: rows.length };
          });
          assert(focused.index === focused.rows - 1, `back landed on row ${focused.index} of ${focused.rows}`);
        } else {
          await clickEl(await call(centerOfText, "header", '[role="radio"]', labels.settings));
        }
        const count = await until("chat app rows", chatAppRows);
        assert(count === 4, `expected 4 chat app rows, got ${count}`);
        await shot(`${localeName}-${width}-settings-list`);
        // Each bot has its own page; the first and the last also run the menu checks.
        for (let index = 0; index < count; index++) {
          await openBot(index, labels);
          assert(await call(pageFits), `bot page ${index} overflows horizontally`);
          await shot(`${localeName}-${width}-bot-${index}`);
          if (index === 0 || index === count - 1) {
            await menuScenario(localeName, labels, width, `agent bot ${index}`, 1);
          }
          await backToList(labels);
        }

        assert(
          await call(() => !document.querySelector('header button[aria-haspopup="menu"]')),
          "redundant agent header menu is still present",
        );

        // --- single-connection agent: the reported clipped-menu case ---
        await goto(`/a/${singleSlug}`, labels);
        await clickEl(await call(centerOfText, "header", '[role="radio"]', labels.settings));
        await openBot(0, labels);
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
            const t = connTriggers(more)[0] ?? document.querySelector('[id^="connection-"]');
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
        if (envSlug) await profileScenario(localeName, labels, width);
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
      // An installed harness its updater says is behind offers the update in its row.
      await until("update button", rowButtonCenter, "Update Test", labels.updateTo);

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

    // --- Settings Harnesses collapse/expand when there are many harnesses (MING-157) ---
    const brainsCollapseScenario = async (localeName, labels, width) => {
      const tag = `brains-collapse ${localeName} ${width}`;
      await metrics(width);
      await call(() => {
        sessionStorage.setItem(
          "mingle.install-review",
          JSON.stringify({ job: null, installed: false, starts: 0, many: true }),
        );
      });
      await send("Page.navigate", { url: `${url}/settings#token=${token}` });
      await until("page load", () => document.readyState === "complete" && !!document.querySelector("header"));
      await call((locale) => localStorage.setItem("mingle.locale", locale), labels.storage);
      await send("Page.reload");
      const toggleCenter = (wanted) => {
        const btn = [...document.querySelectorAll("button[aria-expanded]")].find(
          (b) => b.textContent.trim() === wanted,
        );
        if (!btn) return null;
        btn.scrollIntoView({ block: "center" });
        const r = btn.getBoundingClientRect();
        return r.width && r.height
          ? { x: r.left + r.width / 2, y: r.top + r.height / 2, expanded: btn.getAttribute("aria-expanded") }
          : null;
      };
      // 10 harnesses total (5 installed, 5 uninstalled): collapsed shows 4 installed + 6 hidden.
      const collapsedBtn = await until("collapsed toggle", toggleCenter, labels.showMore(6));
      assert(collapsedBtn.expanded === "false", `${tag}: aria-expanded should be false while collapsed`);
      assert(await call(rowHas, "Update Test", "1.0.0"), `${tag}: first installed harness missing`);
      assert(!(await call(rowHas, "Extra Installed 4", "1.0.0")), `${tag}: 5th installed harness should be folded`);
      assert(!(await call(rowHas, "Other Test", labels.notInstalled)), `${tag}: uninstalled harness should be folded`);
      assert(await call(pageFits), `${tag}: horizontal overflow while collapsed`);
      await shot(`${localeName}-${width}-brains-collapsed`);

      // Expand reveals all 10 harnesses and flips toggle to "Show less".
      await clickEl(collapsedBtn);
      const expandedBtn = await until("expanded toggle", toggleCenter, labels.showLess);
      assert(expandedBtn.expanded === "true", `${tag}: aria-expanded should be true while expanded`);
      await until("extra installed visible", rowHas, "Extra Installed 4", "1.0.0");
      await until("other test visible", rowHas, "Other Test", labels.notInstalled);
      assert(await call(pageFits), `${tag}: horizontal overflow while expanded`);
      await shot(`${localeName}-${width}-brains-expanded`);

      // Collapse hides the overflow rows again.
      await clickEl(expandedBtn);
      await until("re-collapsed toggle", toggleCenter, labels.showMore(6));
      assert(!(await call(rowHas, "Other Test", labels.notInstalled)), `${tag}: uninstalled harness still visible`);

      // A running install on an otherwise-hidden harness stays visible even after reload.
      await call(() => {
        sessionStorage.setItem(
          "mingle.install-review",
          JSON.stringify({
            job: { id: "j-install-test", kind: "install", harness: "install-test", state: "running", events: [] },
            installed: false,
            starts: 1,
            many: true,
          }),
        );
      });
      await send("Page.reload");
      await until("running install stays visible", rowHas, "Install Test", labels.installing);
      await until("collapsed count accounts for pinned row", toggleCenter, labels.showMore(5));
      await resetFixture();
    };
    for (const [localeName, labels] of Object.entries(LOCALES)) {
      for (const width of [1440, 560]) {
        await brainsCollapseScenario(localeName, labels, width);
        passed++;
        console.log(`brains-collapse ${localeName} ${width}: passed`);
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

    // --- the owner closes a task and cancels a reminder, here on a paused agent (MING-75) ---
    const workScenario = async (localeName, labels, width, task, reminder) => {
      const tag = `work ${localeName} ${width}`;
      const auth = { headers: { authorization: `Bearer ${token}` } };
      await fetch(`${url}/v1/admin/agents/${pauseSlug}/pause`, { ...auth, method: "POST" });
      await metrics(width);
      await goto(`/a/${pauseSlug}`, labels);
      // The visible copy of the list: the side panel when wide, the main column when narrow.
      const rowAt = (label) => {
        const el = [...document.querySelectorAll("span[title]")].find((s) => s.title === label && s.offsetParent);
        const row = el?.closest(".group");
        if (!row) return null;
        row.scrollIntoView({ block: "center" });
        const r = row.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      };
      const actionAt = (aria) => {
        const el = [...document.querySelectorAll("button[aria-label]")].find(
          (b) => b.getAttribute("aria-label") === aria && b.offsetParent,
        );
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, shown: getComputedStyle(el.parentElement).opacity };
      };
      const gone = (label) => ![...document.querySelectorAll("span[title]")].some((s) => s.title === label);
      for (const [kind, label, aria, yes] of [
        ["task", task, labels.closeTask + task, labels.closeTaskYes],
        ["reminder", reminder, labels.cancelReminder + reminder, labels.cancelReminderYes],
      ]) {
        // Quiet until hovered.
        const row = await settled(`${kind} row`, rowAt, label);
        assert((await call(actionAt, aria))?.shown === "0", `${tag}: ${kind} action shows before hover`);
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: row.x, y: row.y });
        await until(
          `${kind} action on hover`,
          (a) => {
            const b = [...document.querySelectorAll("button[aria-label]")].find(
              (x) => x.getAttribute("aria-label") === a && x.offsetParent,
            );
            return b && getComputedStyle(b.parentElement).opacity === "1";
          },
          aria,
        );
        await shot(`${localeName}-${width}-${kind}-hover`);
        await clickEl(await call(actionAt, aria));
        await until(`${kind} confirm`, buttonByText, yes);
        assert(await call(pageFits), `${tag}: horizontal overflow while confirming`);
        await shot(`${localeName}-${width}-${kind}-confirm`);
        await clickEl(await call(buttonByText, yes));
        await until(`${kind} gone`, gone, label);
      }
      await send("Page.reload");
      await until("app ready after reload", () => !!document.querySelector('header [role="radiogroup"]'));
      await until(
        "work loaded",
        (l) => [...document.querySelectorAll("span[title]")].some((s) => s.title === l),
        labels.storage === "en" ? "Ask about the cable car" : "确认缆车末班时间",
      );
      assert(await call(gone, task), `${tag}: task back after reload`);
      assert(await call(gone, reminder), `${tag}: reminder back after reload`);
      const work = await (await fetch(`${url}/v1/admin/agents/${pauseSlug}/work`, auth)).json();
      assert(!work.tasks.some((t) => t.title === task), `${tag}: API still lists the task`);
      assert(!work.reminders.some((r) => r.body === reminder), `${tag}: API still lists the reminder`);
      await fetch(`${url}/v1/admin/agents/${pauseSlug}/resume`, { ...auth, method: "POST" });
    };
    await workScenario("en-US", LOCALES["en-US"], 1440, "Draft the packing list", "Post the daily summary");
    passed++;
    console.log("work en-US 1440: passed");
    await workScenario("zh-CN", LOCALES["zh-CN"], 560, "整理装备清单，周四前发到群里", "每天 9 点在群里发昨日总结");
    passed++;
    console.log("work zh-CN 560: passed");

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

    // --- hand off from another conversation: copy the prompt, or paste (MING-81) ---
    /** A button by its exact text inside the Handoff section only (Copy also names the diagnostics button). */
    const handoffButton = (title, wanted) => {
      const section = [...document.querySelectorAll("section")].find(
        (s) => s.querySelector("h2")?.textContent.trim() === title,
      );
      const el = section && [...section.querySelectorAll("button")].find((b) => b.textContent.trim() === wanted);
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    };
    const handoffScenario = async (localeName, labels, width) => {
      const tag = `handoff ${localeName} ${width}`;
      await metrics(width);
      await goto(`/a/${slug}`, labels);
      await clickEl(await call(centerOfText, "header", '[role="radio"]', labels.settings));
      await clickEl(await settled("handoff button", handoffButton, labels.handoffTitle, labels.handoffOpen));
      await until("prompt", () =>
        [...document.querySelectorAll("pre")].some((p) => p.textContent.includes(" handoff ")),
      );
      assert(await call(pageFits), `${tag}: horizontal overflow`);
      await shot(`${localeName}-${width}-handoff-copy`);
      await clickEl(await settled("copy prompt", handoffButton, labels.handoffTitle, labels.handoffCopy));
      // Headless Chrome may refuse the clipboard; then the panel says to copy by hand and does not wait.
      const copied = await until(
        "copied or refused",
        (waiting, refused) => {
          if (document.body.textContent.includes(waiting)) return "copied";
          return [...document.querySelectorAll("p")].some((p) => p.textContent.trim() === refused) ? "refused" : null;
        },
        labels.handoffWaiting,
        labels.handoffCopyFailed,
      );
      if (copied === "copied") await shot(`${localeName}-${width}-handoff-waiting`);
      // What the other conversation's `mingle handoff` does.
      const response = await fetch(`${url}/v1/admin/agents/${slug}/handoffs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          via: "command",
          body: `## Weekend route planning (${localeName} ${width}) — handed off from a Claude Code session in ~/hiking/a-very-long-directory-name-for-checking-truncation\n- Candidates: Xiangshan north loop (12 km), Fenghuangling (9 km)\n- Files: ~/hiking/routes/2026-11/`,
        }),
      });
      assert(response.ok, `${tag}: handoff refused (${response.status})`);
      if (copied === "copied") {
        await until("received", () => !!document.querySelector('span[role="status"].text-green'));
      }
      await until(
        "listed",
        (mark) => [...document.querySelectorAll("span")].some((s) => s.textContent.startsWith(mark)),
        `Weekend route planning (${localeName} ${width})`,
      );
      assert(await call(pageFits), `${tag}: horizontal overflow`);
      await shot(`${localeName}-${width}-handoff-received`);

      await clickEl(await settled("paste tab", handoffButton, labels.handoffTitle, labels.handoffPaste));
      await until("paste box", () => document.activeElement?.tagName === "TEXTAREA");
      await send("Input.insertText", {
        text: "周末徒步群的路线规划，目前的进展：\n1. 候选路线三条：香山北线、凤凰岭、百望山\n2. 张三膝盖不好，避开长下坡\n3. 相关文件：~/hiking/routes/2026-11/*.gpx",
      });
      await until("size shown", () => /KB/.test(document.body.textContent));
      assert(await call(pageFits), `${tag}: horizontal overflow`);
      await shot(`${localeName}-${width}-handoff-paste`);
      await clickEl(await settled("send", handoffButton, labels.handoffTitle, labels.handoffSend));
      await until("sent", () => !!document.querySelector('p[role="status"].text-green'));
      assert(await call(pageFits), `${tag}: horizontal overflow`);
      await shot(`${localeName}-${width}-handoff-sent`);

      await clickEl(await call(centerOfText, "header", '[role="radio"]', labels.activity));
      await until("feed entry", (text) => document.body.textContent.includes(text), labels.handoffFeed);
      assert(await call(pageFits), `${tag}: horizontal overflow`);
      await shot(`${localeName}-${width}-handoff-activity`);
    };
    for (const [localeName, labels] of Object.entries(LOCALES)) {
      for (const width of [1440, 560]) {
        await handoffScenario(localeName, labels, width);
        passed++;
        console.log(`handoff ${localeName} ${width}: passed`);
      }
    }

    // --- keyboard shortcuts: Command on macOS, Ctrl elsewhere (MING-93) ---
    const modifier = await call(() => (/Mac|iPhone|iPad/.test(navigator.userAgent) ? 4 : 2));
    const press = async (k, code, vk, modifiers = 0) => {
      for (const type of ["keyDown", "keyUp"]) {
        await send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, modifiers });
      }
    };
    const path = () => location.pathname;
    const shortcutScenario = async (localeName, labels, width) => {
      const tag = `shortcuts ${localeName} ${width}`;
      await metrics(width);
      await goto(`/a/${slug}`, labels);
      await press(",", "Comma", 188, modifier);
      await until("settings by shortcut", () => location.pathname === "/settings");
      await press("n", "KeyN", 78, modifier);
      await until("new agent by shortcut", () => location.pathname === "/new");
      await press("1", "Digit1", 49, modifier);
      await until("first agent by shortcut", () => location.pathname.startsWith("/a/"));
      const first = await call(path);
      await press("2", "Digit2", 50, modifier);
      await until(
        "second agent by shortcut",
        (p) => location.pathname.startsWith("/a/") && location.pathname !== p,
        first,
      );

      // The agent's tabs: ⇧⌘[ ⇧⌘] on macOS, Ctrl+Page Up / Down elsewhere.
      await goto(`/a/${slug}`, labels);
      const tabChecked = (label) =>
        [...document.querySelectorAll('header [role="radio"]')].some(
          (b) => b.textContent.trim() === label && b.getAttribute("aria-checked") === "true",
        );
      if (modifier === 4) await press("}", "BracketRight", 221, modifier | 8);
      else await press("PageDown", "PageDown", 34, modifier);
      await until("settings tab by shortcut", tabChecked, labels.settings);
      if (modifier === 4) await press("{", "BracketLeft", 219, modifier | 8);
      else await press("PageUp", "PageUp", 33, modifier);
      await until("activity tab by shortcut", tabChecked, labels.activity);

      // Holding the modifier alone shows every shortcut beside its button; letting go hides them.
      const hintsShown = () => {
        const badges = [...document.querySelectorAll("span[aria-hidden] > kbd")].map((k) => k.parentElement);
        const shown = badges.filter((b) => b.offsetParent && getComputedStyle(b).opacity === "1");
        return badges.length > 0 && shown.length === badges.filter((b) => b.offsetParent).length ? shown.length : 0;
      };
      const hintsHidden = () =>
        [...document.querySelectorAll("span[aria-hidden] > kbd")].every(
          (k) => getComputedStyle(k.parentElement).opacity === "0",
        );
      const modKey = modifier === 4 ? ["Meta", "MetaLeft", 91] : ["Control", "ControlLeft", 17];
      await send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: modKey[0],
        code: modKey[1],
        windowsVirtualKeyCode: modKey[2],
        modifiers: modifier,
      });
      await sleep(200);
      assert(await call(hintsHidden), `${tag}: hints showed before the hold delay`);
      const shown = await until("hints while held", hintsShown);
      // Two tabs, at least two agents, New agent and Settings.
      assert(shown >= (width < 768 ? 2 : 6), `${tag}: only ${shown} hints`);
      assert(await call(pageFits), `${tag}: horizontal overflow with hints`);
      await shot(`${localeName}-${width}-shortcut-hints`);
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: modKey[0],
        code: modKey[1],
        windowsVirtualKeyCode: modKey[2],
      });
      await until("hints hidden on release", hintsHidden);

      if (width >= 768) {
        // Pointing at a sidebar row shows its name and keys, soon.
        const rowAt = await call(() => {
          const el = document.querySelector("aside nav button");
          const r = el?.getBoundingClientRect();
          return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
        });
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rowAt.x, y: rowAt.y });
        const started = Date.now();
        await until("tooltip", () => !!document.querySelector('[role="tooltip"] kbd'));
        assert(Date.now() - started < 1500, `${tag}: tooltip took ${Date.now() - started} ms`);
        await shot(`${localeName}-${width}-shortcut-tooltip`);
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: width - 4, y: 880 });
        await until("tooltip gone", () => !document.querySelector('[role="tooltip"]'));
      }

      // Command-Return saves the role; Escape leaves the editor without saving.
      await goto(`/a/${slug}`, labels);
      await clickEl(await call(centerOfText, "header", '[role="radio"]', labels.settings));
      await clickEl(await settled("edit role", handoffButton, labels.roleTitle, labels.edit));
      await until("role editor", () => document.activeElement?.tagName === "TEXTAREA");
      const role = `Plans weekend hikes (${tag})`;
      await call(() => {
        const el = document.activeElement;
        el.select();
      });
      await send("Input.insertText", { text: role });
      await press("Enter", "Enter", 13, modifier);
      await until("role saved", (saved) => document.body.textContent.includes(saved), labels.roleSaved);
      assert(!(await call(() => !!document.querySelector("textarea"))), `${tag}: editor still open after save`);
      await until("role shown", (r) => document.body.textContent.includes(r), role);
      await clickEl(await settled("edit role again", handoffButton, labels.roleTitle, labels.edit));
      await until("role editor again", () => document.activeElement?.tagName === "TEXTAREA");
      await send("Input.insertText", { text: " (discarded)" });
      await press("Escape", "Escape", 27);
      await until("editor closed by Escape", () => !document.querySelector("textarea"));
      assert(
        await call(
          (r) => document.body.textContent.includes(r) && !document.body.textContent.includes("(discarded)"),
          role,
        ),
        `${tag}: Escape kept the draft`,
      );

      // Escape closes the handoff panel.
      await clickEl(await settled("handoff button", handoffButton, labels.handoffTitle, labels.handoffOpen));
      await clickEl(await settled("paste tab", handoffButton, labels.handoffTitle, labels.handoffPaste));
      await until("paste box", () => document.activeElement?.tagName === "TEXTAREA");
      await press("Escape", "Escape", 27);
      await until("handoff closed by Escape", () => !document.querySelector("textarea"));
      await settled("handoff button back", handoffButton, labels.handoffTitle, labels.handoffOpen);

      if (width < 768) {
        // Escape closes the sidebar opened over the page.
        await clickEl(
          await until(
            "menu button",
            (label) => {
              const el = document.querySelector(`button[aria-label="${label}"]`);
              const r = el?.getBoundingClientRect();
              return r?.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
            },
            labels.navMenu,
          ),
        );
        await until("drawer open", () => !!document.querySelector("div.fixed.inset-0"));
        await press("Escape", "Escape", 27);
        await until("drawer closed by Escape", () => !document.querySelector("div.fixed.inset-0"));
      }
      assert(await call(pageFits), `${tag}: horizontal overflow`);
    };
    await shortcutScenario("en-US", LOCALES["en-US"], 1440);
    passed++;
    console.log("shortcuts en-US 1440: passed");
    await shortcutScenario("zh-CN", LOCALES["zh-CN"], 560);
    passed++;
    console.log("shortcuts zh-CN 560: passed");

    // --- one agent on two WeChat accounts: name the second owner under Contacts (MING-55, MING-80) ---
    const ownerScenario = async (localeName, labels, width) => {
      const tag = `owner ${localeName} ${width}`;
      await metrics(width);
      await goto(`/a/${sharedSlug}`, labels);
      await clickEl(await call(centerOfText, "header", '[role="radio"]', labels.settings));
      const rows = await until("chat app rows", chatAppRows);
      assert(rows === 2, `${tag}: expected 2 chat app rows, got ${rows}`);
      await until("unnamed owner", (u) => document.body.textContent.includes(u), labels.ownerUnnamed);
      assert(await call(pageFits), `${tag}: horizontal overflow`);
      await shot(`${localeName}-${width}-owner-unnamed`);
      // Two owners on one app: the chat apps ask whether they are one person.
      await until("all-me card", (want) => document.body.textContent.includes(want), labels.allMe);
      await call((want) => {
        const el = [...document.querySelectorAll("span")].find((x) => x.textContent.trim() === want);
        el?.scrollIntoView({ block: "center" });
      }, labels.allMe);
      assert(await call(pageFits), `${tag}: all-me card overflows horizontally`);
      await shot(`${localeName}-${width}-all-me`);
      // The second bot's page lists the people who wrote to it.
      await openBot(1, labels);
      await until("contacts", envSection, labels.contactsTitle);
      assert(await call(pageFits), `${tag}: contacts overflow horizontally`);
      await shot(`${localeName}-${width}-contacts`);
      const row = (title, text = "u3hr") => {
        const section = [...document.querySelectorAll("section h2")]
          .find((h) => h.textContent.trim() === title)
          ?.closest("section");
        const el = [...(section?.querySelectorAll("button") ?? [])].find((b) => b.textContent.includes(text));
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
      };
      // A person the agent linked: each account, its marks, and the owner's way to confirm or undo it.
      await clickEl(await until("linked person row", row, labels.contactsTitle, "Zhang Sanfeng"));
      await until("person form", () => document.activeElement?.tagName === "INPUT");
      assert(await call(pageFits), `${tag}: person form overflows horizontally`);
      await shot(`${localeName}-${width}-contacts-person`);
      await key("Escape", "Escape", 27);
      await until("person form closed", () => !document.querySelector("form"));
      // The second owner has no name: open it in place and name it.
      await clickEl(await until("unnamed owner row", row, labels.contactsTitle));
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
            mode === "fail"
              ? { error: "http_error" }
              : path.includes("/conversations")
                ? []
                : { tasks: [], reminders: [] },
          ),
          { status: mode === "fail" ? 500 : 200, headers: { "content-type": "application/json" } },
        );
      window.fetch = (input, init) => {
        const path = typeof input === "string" ? input : input.url;
        const method = init?.method || "GET";
        if (method === "GET" && /\/v1\/admin\/agents\/[^/]+\/(conversations|work)(\?|$)/.test(path)) {
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
        const row = body?.closest("[data-message]");
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
          const row = body?.closest("[data-message]");
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
          return body?.closest("[data-message]")?.textContent.includes(ignored) ?? false;
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
    // Remote creation, local-only host preparation errors, and stale-state presentation.
    for (const [localeName, labels] of Object.entries(LOCALES)) {
      const zh = localeName === "zh-CN";
      for (const width of [1024, 560]) {
        await metrics(width, 1600);
        await call(() => sessionStorage.setItem("mingle.ssh-review", "online"));
        await goto(`/a/ssh_0123456789ab~remote-review`, labels);
        await until("remote location", () =>
          document.body.textContent.includes("developer@remote-development-machine.example"),
        );
        assert(await call(pageFits), "remote status overflows");
        await shot(`${localeName}-${width}-ssh-online`);
        await spaNav("/new");
        // Running elsewhere is a word in the brain step's hint, not a field above the form.
        await until(
          "location word",
          (label) => !!document.querySelector(`main button[aria-label="${label}"]`),
          zh ? "运行位置" : "Run on",
        );
        // The chosen brain's model picker is a legitimate select here; only the SSH
        // form's own controls may not take room before the location menu is opened.
        assert(
          await call(
            (model) =>
              [...document.querySelectorAll("main select")].every((s) => s.getAttribute("aria-label") === model) &&
              !document.querySelector('input[placeholder="user@host"]'),
            zh ? "模型" : "Model",
          ),
          "location takes room before it is opened",
        );
        await shot(`${localeName}-${width}-ssh-local`);
        await clickEl(
          await call(
            (label) => {
              const r = document.querySelector(`main button[aria-label="${label}"]`).getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            },
            zh ? "运行位置" : "Run on",
          ),
        );
        await until("location menu", () => document.querySelectorAll('[role="menuitemradio"]').length === 3);
        await shot(`${localeName}-${width}-ssh-menu`);
        await clickEl(
          await call(centerOfText, "body", '[role="menuitemradio"]', zh ? "添加 SSH 主机…" : "Add SSH host…"),
        );
        await until("host form", () => !!document.querySelector('input[placeholder="user@host"]'));
        await until("config aliases", () => !!document.querySelector('option[value="review-fixture"]'));
        assert(await call(pageFits), "SSH host form overflows");
        await shot(`${localeName}-${width}-ssh-add`);
        const setInput = (selector, value) => {
          const input = document.querySelector(selector);
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        };
        // Refresh is read-only; empty and failed reads still allow manual targets.
        for (const mode of ["empty", "failed", "partial"]) {
          await call((mode) => sessionStorage.setItem("mingle.ssh-config", mode), mode);
          await clickEl(await call(centerOfText, "main", "button", zh ? "刷新" : "Refresh"));
          const messages = zh
            ? { empty: "没有找到主机别名", failed: "无法读取 SSH 配置", partial: "部分配置未能读取" }
            : {
                empty: "No host aliases found",
                failed: "Could not read SSH config",
                partial: "Some configuration could not be read",
              };
          await until("config result", (text) => document.body.textContent.includes(text), messages[mode]);
          assert(await call(pageFits), "SSH config message overflows");
          await shot(`${localeName}-${width}-ssh-config-${mode}`);
        }
        await call(() => sessionStorage.removeItem("mingle.ssh-config"));
        await call(setInput, 'input[placeholder="user@host"]', "bad-host");
        await clickEl(await call(centerOfText, "main", "button", zh ? "准备并连接" : "Prepare and connect"));
        await until(
          "localized SSH error",
          (text) => document.body.textContent.includes(text),
          zh ? "SSH 认证失败" : "SSH authentication failed",
        );
        await shot(`${localeName}-${width}-ssh-error`);
        await clickEl(await call(centerOfText, "main", "button", zh ? "刷新" : "Refresh"));
        await until(
          "config refreshed",
          () => !document.querySelector('option[value="review-fixture"]').parentElement.disabled,
        );
        assert(
          await call(() => document.querySelector('input[placeholder="user@host"]').value === "bad-host"),
          "refresh discarded manual target",
        );
        await call(setInput, 'input[placeholder="user@host"]', "missing-node");
        await clickEl(await call(centerOfText, "main", "button", zh ? "准备并连接" : "Prepare and connect"));
        await until(
          "remote installer",
          (text) => document.body.textContent.includes(text),
          zh ? "在远端安装 Node.js" : "Install Node.js on the remote host",
        );
        assert(await call(pageFits), "remote installer overflows");
        assert(
          await call(() =>
            /github\.com\/gerayking\/Mingle\/blob\/[a-f0-9]{40}\/scripts\/install-remote\.sh$/.test(
              document.querySelector('a[href*="scripts/install-remote.sh"]').href,
            ),
          ),
          "installer source is not pinned",
        );
        assert(await call(() => !document.querySelector("main pre")), "manual command should be collapsed");
        await shot(`${localeName}-${width}-ssh-install-auto`);
        await clickEl(await call(centerOfText, "main", "button", zh ? "手动安装" : "Manual installation"));
        await clickEl(await call(centerOfText, "main", "button", zh ? "复制安装命令" : "Copy install command"));
        await until(
          "install command copied or shown",
          (copied, failed) => document.body.textContent.includes(copied) || document.body.textContent.includes(failed),
          zh ? "已复制命令" : "Command copied",
          zh ? "复制失败" : "Could not copy",
        );
        await shot(`${localeName}-${width}-ssh-install`);
        await clickEl(await call(centerOfText, "main", "button", zh ? "手动安装" : "Manual installation"));
        await clickEl(await call(centerOfText, "main", "button", zh ? "安装并连接" : "Install and connect"));
        await until(
          "install progress",
          (text) => document.body.textContent.includes(text),
          zh ? "正在安装远端环境" : "Installing remote environment",
        );
        assert(
          await call(() => document.querySelector('input[placeholder="user@host"]').disabled),
          "host changed during installation",
        );
        assert(
          await call(
            (label) => !document.querySelector(`main button[aria-label="${label}"]`),
            zh ? "运行位置" : "Run on",
          ),
          "location can be left during installation",
        );
        await shot(`${localeName}-${width}-ssh-install-running`);
        await call(() => sessionStorage.setItem("mingle.ssh-install-phase", "poll-failed"));
        await until(
          "install progress unavailable",
          (text) => document.body.textContent.includes(text),
          zh ? "重查进度" : "Check progress again",
        );
        await shot(`${localeName}-${width}-ssh-install-poll-failed`);
        await call(() => sessionStorage.setItem("mingle.ssh-install-phase", "preparing"));
        await clickEl(await call(centerOfText, "main", "button", zh ? "重查进度" : "Check progress again"));
        await until(
          "install preparing",
          (text) => document.body.textContent.includes(text),
          zh ? "正在准备远端 Mingle" : "Preparing remote Mingle",
        );
        await shot(`${localeName}-${width}-ssh-install-preparing`);
        await call(() => sessionStorage.setItem("mingle.ssh-install-phase", "failed"));
        await until(
          "install failed",
          (text) => document.body.textContent.includes(text),
          zh ? "远端主机无法下载" : "The remote host could not download",
        );
        assert(
          await call(() => !document.querySelector('input[placeholder="user@host"]').disabled),
          "failed installation cannot be retried",
        );
        await shot(`${localeName}-${width}-ssh-install-failed`);
        await call(() => {
          const select = document.querySelector('option[value="review-fixture"]').parentElement;
          select.value = "review-fixture";
          select.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await until(
          "config alias selected",
          () => document.querySelector('input[placeholder="user@host"]').value === "review-fixture",
        );
        assert(
          await call(() => !document.querySelector('a[href*="scripts/install-remote.sh"]')),
          "installer state leaked to another host",
        );
        await clickEl(await call(centerOfText, "main", "button", zh ? "安装远端环境" : "Install remote environment"));
        await clickEl(await call(centerOfText, "main", "button", zh ? "安装并连接" : "Install and connect"));
        await until(
          "install retry started",
          (text) => document.body.textContent.includes(text),
          zh ? "正在安装远端环境" : "Installing remote environment",
        );
        await call(() => sessionStorage.setItem("mingle.ssh-install-phase", "done"));
        await until("remote brain", () => document.body.textContent.includes("Remote test brain"));
        assert(
          await call(() => JSON.parse(sessionStorage.getItem("mingle.ssh-installed")).host === "review-fixture"),
          "installation did not use the SSH config alias",
        );
        assert(await call(pageFits), "remote brain form overflows");
        await shot(`${localeName}-${width}-ssh-ready`);
        await call(setInput, "input[aria-label]", "Remote companion");
        await call(() => document.querySelector('button[type="submit"]').scrollIntoView({ block: "center" }));
        await clickEl(
          await call(() => {
            const button = document.querySelector('button[type="submit"]');
            const r = button.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }),
        );
        await until("remote create navigation", () =>
          location.pathname.includes("ssh_0123456789ab~remote-review/connect"),
        );
        assert(
          await call(
            () => JSON.parse(sessionStorage.getItem("mingle.ssh-created")).harness === "ssh_0123456789ab~scripted",
          ),
          "created agent used local harness",
        );
        await call(() => sessionStorage.setItem("mingle.ssh-review", "offline"));
        await goto(`/a/ssh_0123456789ab~remote-review`, labels);
        await until(
          "unreachable banner",
          (text) => document.body.textContent.includes(text),
          zh ? "SSH 暂时无法连接" : "SSH is unreachable",
        );
        assert(await call(pageFits), "unreachable remote page overflows");
        await shot(`${localeName}-${width}-ssh-offline`);
        // A rebooted host is prepared again from its agent's page, in place.
        await clickEl(await call(centerOfText, "main", "button", zh ? "准备或重新连接" : "Prepare or reconnect"));
        await until(
          "reconnect in place",
          (text) => document.body.textContent.includes(text),
          zh ? "远端主机重启后可在此恢复服务" : "Use after the remote host restarts",
        );
        assert(await call(pageFits), "reconnect panel overflows");
        await shot(`${localeName}-${width}-ssh-reconnect`);
        await call(() => sessionStorage.removeItem("mingle.ssh-review"));
        passed++;
        console.log(`remote ${localeName} ${width}: passed`);
      }
    }
    // --- bot permissions: each one a row, the optional ones turned on in place -------------
    for (const [localeName, labels] of Object.entries(LOCALES)) {
      const zh = localeName === "zh-CN";
      for (const width of [1440, 560]) {
        for (const state of ["off", "granted", "several"]) {
          const tag = `permissions ${localeName} ${width} ${state}`;
          await metrics(width);
          await send("Page.navigate", { url: `${url}/a/${slug}#token=${token}` });
          await until("page load", () => document.readyState === "complete" && !!document.querySelector("header"));
          await call(
            (locale, mode) => {
              localStorage.setItem("mingle.locale", locale);
              sessionStorage.setItem("mingle.permissions-review", mode);
            },
            labels.storage,
            state,
          );
          await send("Page.reload");
          await until("app ready", () => !!document.querySelector('header [role="radiogroup"]'));
          await call((settings) => {
            const tab = [...document.querySelectorAll('header [role="radio"]')].find(
              (b) => b.textContent.trim() === settings,
            );
            tab?.click();
          }, labels.settings);
          // Rows load in over a moment: click once the row has stopped moving.
          await clickEl(await settled("feishu bot row", centerOfText, "main", "span", "Alex 徒步助手"));
          await until(
            "feishu bot page",
            (name) => document.querySelector("main nav") && document.body.textContent.includes(name),
            zh ? "飞书" : "Feishu",
          );
          const profiles = zh ? "成员资料" : "Member profiles";
          await until("permission rows", (text) => document.body.textContent.includes(text), profiles);
          const turnOn = await call(centerOfText, "main", "button", zh ? "开启" : "Turn on");
          assert(
            state === "granted" ? !turnOn : Boolean(turnOn),
            `${tag}: turn-on button ${turnOn ? "shown" : "missing"}`,
          );
          // More than one permission off gets a single button that scans for all of them.
          const turnAll = await call(centerOfText, "main", "button", zh ? "全部开启" : "Turn all on");
          assert(
            state === "several" ? Boolean(turnAll) : !turnAll,
            `${tag}: turn-all-on button ${turnAll ? "shown" : "missing"}`,
          );
          await until(
            "contact with profile",
            (text) => document.body.textContent.includes(text),
            "KubeBlocks Enterprise 产品部",
          );
          assert(await call(pageFits), `${tag}: page overflows`);
          await shot(`${localeName}-${width}-permissions-${state}`);
          if ((state === "off" || state === "several") && width === 1440) {
            // Turning on opens the scan in place: one row adds one, "Turn all on" adds them all.
            await clickEl(state === "several" ? turnAll : turnOn);
            await until(
              "scan opens in place",
              (cancel) => [...document.querySelectorAll("main button")].some((b) => b.textContent.trim() === cancel),
              labels.cancel,
            );
            await shot(`${localeName}-${width}-permissions-scan`);
          }
          await call(() => sessionStorage.removeItem("mingle.permissions-review"));
          passed++;
          console.log(`${tag}: passed`);
        }
      }
    }

    // --- sidebar agent drag-and-drop reorder ------------------------------------------------
    {
      const tag = "sidebar agent drag reorder";
      await metrics(1440);
      await goto(`/a/${slug}`, LOCALES["zh-CN"]);
      const rowIds = () =>
        [...document.querySelectorAll("aside [data-agent-row]")].map((el) => el.getAttribute("data-agent-row"));
      const rowBox = (index) => {
        const el = document.querySelectorAll("aside [data-agent-row]")[index];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, height: r.height };
      };
      const before = await call(rowIds);
      assert(before.length >= 3, `${tag}: expected at least 3 agents`);
      const startPath = await call(() => location.pathname);

      // Drag row 1 up above row 0, then press Escape to cancel: order must stay unchanged.
      const r0 = await call(rowBox, 0);
      const r1 = await call(rowBox, 1);
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r1.x, y: r1.y });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: r1.x, y: r1.y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r1.x, y: r1.y - 12, buttons: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r0.x, y: r0.top + 4, buttons: 1 });
      await key("Escape", "Escape", 27);
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: r0.x,
        y: r0.top + 4,
        button: "left",
        clickCount: 1,
      });
      await new Promise((r) => setTimeout(r, 240));
      assert(JSON.stringify(await call(rowIds)) === JSON.stringify(before), `${tag}: Escape did not cancel drag`);

      // Drag row 1 up above row 0 and release: order updates immediately and persists across reload.
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r1.x, y: r1.y });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: r1.x, y: r1.y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r1.x, y: r1.y - 12, buttons: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r0.x, y: r0.top + 4, buttons: 1 });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: r0.x,
        y: r0.top + 4,
        button: "left",
        clickCount: 1,
      });
      const expected = [before[1], before[0], ...before.slice(2)];
      await until(
        "reordered sidebar",
        (want) =>
          JSON.stringify(
            [...document.querySelectorAll("aside [data-agent-row]")].map((el) => el.getAttribute("data-agent-row")),
          ) === want,
        JSON.stringify(expected),
      );
      // Dropping must not accidentally navigate to the dragged row.
      assert((await call(() => location.pathname)) === startPath, `${tag}: drop triggered navigation`);

      // Wait briefly for PUT /v1/admin/agents/order, then reload and verify persistence.
      await until(
        "order persisted on server",
        async (want) => {
          const t = sessionStorage.getItem("mingle.token") || "";
          const res = await fetch("/v1/admin/status", { headers: { authorization: `Bearer ${t}` } });
          const data = await res.json();
          return JSON.stringify(data.agents.map((a) => a.id)) === want;
        },
        JSON.stringify(expected),
      );
      await send("Page.reload");
      await until(
        "reordered after reload",
        (want) =>
          JSON.stringify(
            [...document.querySelectorAll("aside [data-agent-row]")].map((el) => el.getAttribute("data-agent-row")),
          ) === want,
        JSON.stringify(expected),
      );
      assert(await call(pageFits), `${tag}: page overflows`);

      // Restore original order.
      await call(async (ids) => {
        const t = sessionStorage.getItem("mingle.token") || "";
        await fetch("/v1/admin/agents/order", {
          method: "PUT",
          headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
          body: JSON.stringify({ ids }),
        });
      }, before);
      passed++;
      console.log(`${tag}: passed`);
    }

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
