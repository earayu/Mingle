// The website's few behaviors: the download button for this OS, copy buttons,
// reveal on scroll, and the chat that plays itself. Nothing here is needed to read the page.

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Point the hero's button at this computer's download.
const button = document.querySelector("[data-os-download]");
if (button) {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua)
    ? "windows"
    : /Mac/.test(ua) && !/iPhone|iPad/.test(ua)
      ? "mac"
      : /Linux|X11/.test(ua) && !/Android/.test(ua)
        ? "linux"
        : null;
  if (os) {
    button.href = os === "linux" ? "#download" : button.dataset[os];
    button.textContent = button.dataset[`label${os[0].toUpperCase()}${os.slice(1)}`];
  } else button.href = "#download";
}

for (const copy of document.querySelectorAll("[data-copy]")) {
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(copy.dataset.copy);
      const label = copy.textContent;
      copy.textContent = copy.dataset.done;
      setTimeout(() => (copy.textContent = label), 1500);
    } catch {}
  });
}

// Plays a chat once it's on screen: a question, a reaction, "thinking", the answer typed out, and a follow-up.
function play(chat) {
  const steps = [...chat.querySelectorAll(".msg")];
  const answer = chat.querySelector(".answer");
  const typing = chat.querySelector(".typing");
  const text = answer.dataset.text;
  if (reduced) {
    for (const s of steps) s.classList.add("shown");
    typing.hidden = true;
    answer.textContent = text;
    chat.querySelector(".react")?.classList.add("shown");
    return;
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    for (;;) {
      for (const s of steps) s.classList.remove("shown");
      chat.querySelector(".react")?.classList.remove("shown");
      typing.hidden = false;
      answer.textContent = "";
      await wait(500);
      steps[0].classList.add("shown");
      await wait(700);
      chat.querySelector(".react")?.classList.add("shown");
      await wait(500);
      steps[1].classList.add("shown");
      await wait(1400);
      typing.hidden = true;
      for (let i = 0; i <= text.length; i += 2) {
        answer.textContent = text.slice(0, i);
        await wait(28);
      }
      answer.textContent = text;
      await wait(1200);
      steps[2].classList.add("shown");
      await wait(1100);
      steps[3].classList.add("shown");
      await wait(6000);
    }
  })();
}

const seen = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      seen.unobserve(entry.target);
      if (entry.target.matches(".chat:not(.static)")) play(entry.target);
      else entry.target.classList.add("in");
    }
  },
  { rootMargin: "0px 0px -8% 0px" },
);
for (const el of document.querySelectorAll(".reveal, .chat:not(.static)")) seen.observe(el);

// The homepage demo: Alex in several chat apps, scenes from site/scripts/demo.mjs.
// One run at a time; starting a scene cancels the one playing. Reduced motion skips the pauses and typing,
// but the visitor still taps Send on their turns.
const demoData = document.getElementById("demo-data");
if (demoData) demoPlayer(JSON.parse(demoData.textContent), document.getElementById("demo"));

function demoPlayer(data, root) {
  const { ui, icons, names, owner, scenes } = data;
  const phone = root.querySelector(".phone");
  const head = phone.querySelector(".im-head");
  const logs = phone.querySelector(".im-logs");
  const typingLine = phone.querySelector(".im-typing");
  const input = phone.querySelector(".im-input");
  const send = phone.querySelector(".im-send");
  const end = phone.querySelector(".demo-end");
  const banner = phone.querySelector(".demo-banner");
  const tabs = [...root.querySelectorAll("[data-scene]")];
  const CANCEL = Symbol("cancel");
  let run = 0;
  let current = 0;
  let pendingSend = null;

  const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|\s)([@#][^\s,.:;!?，。：；！？]+)/g, '$1<span class="mention">$2</span>');
  const rich = (s) => {
    const lines = s.split("\n");
    let html = "";
    let list = false;
    for (const line of lines) {
      if (line.startsWith("• ")) {
        if (!list) html += "<ul>";
        list = true;
        html += `<li>${inline(line.slice(2))}</li>`;
      } else {
        if (list) html += "</ul>";
        list = false;
        html += `<p>${inline(line)}</p>`;
      }
    }
    return list ? `${html}</ul>` : html;
  };
  const el = (tag, cls, html = "") => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    e.innerHTML = html;
    return e;
  };
  const hue = (name) => [...name].reduce((h, c) => (h * 31 + c.codePointAt(0)) % 360, 7);
  const avatar = (who) =>
    who === "agent"
      ? '<span class="av av-agent">A</span>'
      : `<span class="av" style="--h:${hue(who)}">${esc([...who][0])}</span>`;

  function wait(ms, token) {
    return new Promise((resolve, reject) =>
      setTimeout(() => (token === run ? resolve() : reject(CANCEL)), reduced ? 0 : ms),
    );
  }

  function start(index) {
    const token = ++run;
    current = index;
    if (pendingSend) pendingSend.reject(CANCEL);
    pendingSend = null;
    for (const [i, t] of tabs.entries()) t.setAttribute("aria-selected", String(i === index));
    playScene(scenes[index], token).catch((e) => {
      if (e !== CANCEL) throw e;
    });
  }

  async function playScene(scene, token) {
    const chats = {};
    logs.textContent = "";
    end.hidden = true;
    send.hidden = false;
    input.hidden = false;
    banner.classList.remove("shown");
    for (const [key, chat] of Object.entries(scene.chats)) {
      const log = el("div", "im-log");
      log.setAttribute("role", "log");
      log.hidden = true;
      logs.append(log);
      // lastPerson: the latest message from a person in this chat, where receipts go and what a live reply quotes.
      chats[key] = { ...chat, key, log, minute: 24, lastPerson: null };
    }
    let chat = null;
    let live = null;
    const time = () => `10:${String(chat.minute++).padStart(2, "0")}`;
    const scroll = () => chat.log.scrollTo({ top: chat.log.scrollHeight, behavior: reduced ? "auto" : "smooth" });

    function setTyping(on) {
      const app = chat.app;
      if (app === "wechat") head.querySelector(".im-title").textContent = on ? ui.wechatTyping : chat.name;
      else if (app === "telegram" && !chat.members)
        head.querySelector(".im-sub").textContent = on ? ui.typing : ui.botSub;
      typingLine.textContent = on && (app === "discord" || app === "feishu") ? ui.typingLine : "";
      typingLine.classList.toggle("on", on && (app === "discord" || app === "feishu"));
    }

    function showChat(c) {
      chat = c;
      phone.dataset.app = c.app;
      for (const other of Object.values(chats)) other.log.hidden = other !== c;
      const back = '<span class="im-back" aria-hidden="true"></span>';
      const sub = c.server ? c.server : c.members ? ui.members.replace("{n}", c.members) : ui.botSub;
      const title = c.app === "discord" ? `<span class="hash">#</span>${esc(c.name)}` : esc(c.name);
      const pic = c.members || c.server ? avatar(c.name) : avatar("agent");
      head.innerHTML = `${back}${c.app === "telegram" ? pic : ""}<div class="im-names"><b class="im-title">${title}</b>${
        c.app === "wechat" ? "" : `<small class="im-sub">${esc(sub)}</small>`
      }</div><span class="im-app">${icons[c.app]}<span>${esc(names[c.app])}</span></span>`;
      input.textContent = "";
      input.dataset.placeholder = c.app === "discord" ? `${ui.message} #${c.name}` : ui.message;
      setTyping(false);
      scroll();
    }

    function message(who, html, opts = {}) {
      const mine = who === "me";
      const name = mine ? owner : who === "agent" ? "Alex" : who;
      const m = el(
        "div",
        `m ${mine ? "out" : "in"}${who === "agent" ? " agent" : ""}${opts.cls ? ` ${opts.cls}` : ""}`,
      );
      const tag =
        who === "agent"
          ? `<em class="tag">${esc(ui.bot)}</em>`
          : mine && (chat.members || chat.server)
            ? `<em class="tag tag-owner">${esc(ui.owner)}</em>`
            : "";
      const showName = chat.members || chat.server || chat.app === "feishu";
      m.innerHTML = `${avatar(mine ? owner : who === "agent" ? "agent" : who)}<div class="mb">${
        showName && !(mine && chat.app !== "discord")
          ? `<span class="nm">${esc(name)}${tag}<time>${time()}</time></span>`
          : ""
      }<div class="bb">${opts.quote ? `<div class="q">${opts.quote}</div>` : ""}<div class="tx">${html}</div><span class="im-meta"><time>${
        showName ? "" : time()
      }</time>${mine && chat.app === "telegram" ? '<i class="ticks">✓✓</i>' : ""}</span></div><div class="rx"></div></div>`;
      if (chat.app === "discord" && html.includes(`@${owner}`)) m.classList.add("pinged");
      chat.log.append(m);
      requestAnimationFrame(() => m.classList.add("shown"));
      scroll();
      return m;
    }

    function receipt(emoji) {
      if (!chat.lastPerson) return;
      const rx = chat.lastPerson.querySelector(".rx");
      rx.innerHTML = `<span class="chip">${emoji}${chat.app === "discord" ? " <b>1</b>" : ""}</span>`;
      rx.firstChild.classList.add("pop");
    }

    async function typeInto(node, html, text, token) {
      if (reduced) {
        node.innerHTML = html;
        return;
      }
      for (let i = 2; i < text.length; i += 3) {
        node.textContent = text.slice(0, i);
        scroll();
        await wait(22, token);
      }
      node.innerHTML = html;
      scroll();
    }

    function openLive() {
      const trigger = chat.lastPerson;
      const quote = trigger ? esc(trigger.querySelector(".tx").textContent.slice(0, 48)) : "";
      const card = chat.app === "feishu";
      const m = message("agent", "", { quote: card ? "" : quote, cls: card ? "im-card" : "live" });
      const tx = m.querySelector(".tx");
      tx.innerHTML = `${card ? `<div class="card-head"><span class="spin"></span><b class="status">${esc(ui.thinking)}</b></div>${quote ? `<div class="q">${quote}</div>` : ""}` : `<p class="status">${esc(ui.thinking)}</p>`}<ul class="im-steps"></ul><div class="answer"></div>`;
      const state = { m, tx, trigger, seconds: 0, timer: 0 };
      const tick = () => {
        state.seconds += 1;
        if (state.seconds >= 3) tx.querySelector(".status").textContent = ui.working.replace("{n}", state.seconds);
      };
      state.timer = setInterval(() => (run === token ? tick() : clearInterval(state.timer)), reduced ? 60000 : 700);
      if (reduced) {
        state.seconds = 4;
        tick();
      }
      return state;
    }

    function closeLive(state) {
      clearInterval(state.timer);
      state.tx.querySelector(".im-steps").remove();
      state.tx.querySelector(".status")?.closest(".card-head, p")?.remove();
      // Telegram clears its 👀 once the answer is in; the others swap it for ✅ in the script.
      if (chat.app === "telegram") state.trigger?.querySelector(".rx").replaceChildren();
      if (chat.app !== "feishu")
        state.m
          .querySelector(".im-meta")
          .insertAdjacentHTML("afterbegin", `<span class="edited">${esc(ui.edited)}</span>`);
    }

    for (const step of scene.steps) {
      const [kind, a, b, c] = step;
      if (kind === "chat") {
        const next = chats[a];
        if (b && chat) {
          banner.innerHTML = `${icons[next.app]}<span>${esc(b)}</span>`;
          banner.classList.add("shown");
          await wait(1100, token);
          showChat(next);
          await wait(500, token);
          banner.classList.remove("shown");
          await wait(400, token);
        } else showChat(next);
        await wait(300, token);
      } else if (kind === "divider") {
        chat.log.append(el("div", "divider", `<span>${esc(a)}</span>`));
        await wait(500, token);
      } else if (kind === "in") {
        await wait(700, token);
        chat.lastPerson = message(a, rich(b));
        await wait(900, token);
      } else if (kind === "file") {
        await wait(400, token);
        const who = a;
        const file = `<span class="file"><span class="file-icon">GPX</span><span><b>${esc(b)}</b><small>${esc(c)}</small></span></span>`;
        const m = message(who, file, { cls: "has-file" });
        if (who !== "agent") chat.lastPerson = m;
        await wait(600, token);
      } else if (kind === "ask") {
        input.textContent = a;
        input.classList.add("draft");
        send.disabled = false;
        send.classList.add("pulse");
        send.dataset.tip = ui.tap;
        send.focus({ preventScroll: true });
        await new Promise((resolve, reject) => {
          pendingSend = { resolve, reject };
        });
        pendingSend = null;
        send.disabled = true;
        send.classList.remove("pulse");
        input.textContent = "";
        input.classList.remove("draft");
        chat.lastPerson = message("me", rich(a));
        await wait(600, token);
      } else if (kind === "react") {
        receipt(a);
        await wait(500, token);
      } else if (kind === "live") {
        await wait(400, token);
        live = openLive();
        await wait(1500, token);
      } else if (kind === "tick") {
        const li = el("li", "", inline(a));
        live.tx.querySelector(".im-steps").append(li);
        requestAnimationFrame(() => li.classList.add("shown"));
        scroll();
        await wait(1100, token);
      } else if (kind === "answer" || kind === "stopped") {
        const state = live;
        live = null;
        closeLive(state);
        const node = state.tx.querySelector(".answer");
        if (kind === "stopped") {
          node.innerHTML = `<p class="stopped">${esc(a)}</p>`;
          state.m.classList.add("ended");
        } else if (chat.app === "feishu") await typeInto(node, rich(a), a, token);
        else node.innerHTML = rich(a);
        scroll();
        await wait(900, token);
      } else if (kind === "typing") {
        await wait(300, token);
        setTyping(true);
        await wait(1600, token);
        setTyping(false);
      } else if (kind === "say") {
        await wait(300, token);
        const m = message("agent", "");
        await typeInto(m.querySelector(".tx"), rich(a), a, token);
        await wait(900, token);
      } else if (kind === "toast") {
        await wait(300, token);
        const toast = el("div", "toast", `<span class="toast-check">✓</span>${esc(a)}`);
        chat.log.append(toast);
        requestAnimationFrame(() => toast.classList.add("shown"));
        scroll();
      }
    }
    await wait(800, token);
    const next = (current + 1) % scenes.length;
    end.querySelector("[data-next]").textContent = ui.next.replace("{t}", scenes[next].title);
    input.hidden = true;
    send.hidden = true;
    end.hidden = false;
    // The end buttons take the composer's place and can be taller: keep the closing note in view.
    chat.log.scrollTop = chat.log.scrollHeight;
  }

  send.addEventListener("click", () => pendingSend?.resolve());
  end.querySelector("[data-again]").addEventListener("click", () => start(current));
  end.querySelector("[data-next]").addEventListener("click", () => start((current + 1) % scenes.length));
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => start(i));
    tab.addEventListener("keydown", (e) => {
      const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const to = (i + step + tabs.length) % tabs.length;
      tabs[to].focus();
      start(to);
    });
  });
  const onScreen = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      onScreen.disconnect();
      start(0);
    },
    { rootMargin: "0px 0px -15% 0px" },
  );
  onScreen.observe(phone);
}
