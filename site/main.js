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
