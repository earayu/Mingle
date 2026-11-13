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
    keep: "Keep",
    chatApps: "Chat apps",
  },
  "zh-CN": {
    storage: "zh-CN",
    settings: "设置",
    manage: "管理",
    more: "更多",
    remove: "移除",
    keep: "保留",
    chatApps: "聊天软件",
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function reviewInteractions({ url, token, slug, singleSlug, chrome, out }) {
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

    // Run a function in the page; page errors and timeouts are real failures.
    const prelude = `const connTriggers=(more)=>[...document.querySelectorAll("button[aria-label]")].filter((b)=>b.getAttribute("aria-label")===more&&!b.closest("header")&&!b.closest("aside"));`;
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
      const deadline = Date.now() + 15_000;
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
    const key = async (k, code, vk) => {
      for (const type of ["keyDown", "keyUp"]) {
        await send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk });
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
        // The row swaps to an inline keep/remove confirmation; the connection stays.
        await until("remove confirmation", connHasButton, labels.more, labels.keep);
        if (index === 0) await shot(`${localeName}-${width}-connmenu-confirm`);
        await clickEl(await call(connButtonCenter, labels.more, labels.keep));
        await until(
          "confirmation dismissed",
          (more, wanted) => {
            const t = connTriggers(more)[0] ?? document.querySelector(`button[aria-label="${more}"]`);
            const scope = t?.closest("section") ?? document;
            return ![...scope.querySelectorAll("button")].some((b) => b.textContent.trim() === wanted);
          },
          labels.more,
          labels.keep,
        );
        const after = await call((more) => connTriggers(more).length, labels.more);
        assert(after === count, `${tag}: connection lost after keep (${after} != ${count})`);
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
        assert(count === 3, `expected 3 connection rows, got ${count}`);
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
        await until("remove confirmation", connHasButton, labels.more, labels.keep);
        await clickEl(await call(connButtonCenter, labels.more, labels.keep));
        await until(
          "confirmation dismissed",
          (more, wanted) => {
            const t = connTriggers(more)[0] ?? document.querySelector(`button[aria-label="${more}"]`);
            const scope = t?.closest("section") ?? document;
            return ![...scope.querySelectorAll("button")].some((b) => b.textContent.trim() === wanted);
          },
          labels.more,
          labels.keep,
        );
        assert(
          (await call((more) => connTriggers(more).length, labels.more)) === 1,
          "single connection lost after keep",
        );
        passed++;
        console.log(`interactions ${localeName} ${width}: passed`);
      }
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
