// Builds the website into site/dist: one static page per language, plus llms.txt.
//
//   node site/scripts/build.mjs        → site/dist
//
// Download links point at the release for package.json's version; rebuild after a release.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { copy } from "./copy.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const SITE = join(ROOT, "site");
const OUT = join(SITE, "dist");
const ORIGIN = "https://mingle.build";
const REPO = "https://github.com/earayu/Mingle";
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const release = `${REPO}/releases/download/v${version}`;
const latest = `${REPO}/releases/latest/download`;

const downloads = {
  mac: [
    ["Apple Silicon", `${release}/mingle-${version}-arm64.dmg`],
    ["Intel", `${release}/mingle-${version}-amd64.dmg`],
  ],
  windows: [
    ["x64", `${release}/mingle-setup-${version}-amd64.exe`],
    ["ARM", `${release}/mingle-setup-${version}-arm64.exe`],
  ],
  linux: [
    [".deb x64", `${release}/mingle_${version}_amd64.deb`],
    [".deb ARM", `${release}/mingle_${version}_arm64.deb`],
    [".rpm x64", `${release}/mingle-${version}-1.x86_64.rpm`],
    [".rpm ARM", `${release}/mingle-${version}-1.aarch64.rpm`],
  ],
};
const installSh = `curl -fsSL ${latest}/install.sh | sh`;
const installPs = `irm ${latest}/install.ps1 | iex`;
const fromSource = `git clone ${REPO}.git && cd Mingle\npnpm install && pnpm build\nnode dist/cli/main.js start`;

// The chat apps' marks, taken from the console so the two never drift apart.
const platformsSource = readFileSync(join(ROOT, "web/src/platforms.tsx"), "utf8");
const marksSource = platformsSource
  .slice(platformsSource.indexOf("const marks"), platformsSource.indexOf("export function PlatformIcon"))
  .replace(/^const marks:[^=]+=/, "return");
const marks = new Function(marksSource)();
const platformOrder = ["wechat", "wecom", "feishu", "dingtalk", "qq", "slack", "discord", "telegram"];
const platformIcon = (id, size = 40) => {
  const mark = marks[id];
  const inner = mark.path
    ? `<svg viewBox="0 0 24 24" width="58%" height="58%" fill="currentColor"><path d="${mark.path}"/></svg>`
    : `<svg viewBox="${mark.svg.viewBox}" width="62%" height="62%">${mark.svg.body}</svg>`;
  return `<span class="app-icon" style="--size:${size}px;background:${mark.color}" aria-hidden="true">${inner}</span>`;
};

const harnesses = [
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["opencode", "OpenCode"],
  ["kimi", "Kimi Code"],
  ["qwen", "Qwen Code"],
  ["grok", "Grok Build"],
  ["pi", "Pi"],
];

const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const shot = (name, lang, alt, cls = "") => `
  <figure class="window ${cls}">
    <div class="window-bar" aria-hidden="true"><i></i><i></i><i></i></div>
    <picture>
      <source srcset="/img/${name}-${lang}-dark.png" media="(prefers-color-scheme: dark)">
      <img src="/img/${name}-${lang}-light.png" alt="${esc(alt)}" width="2560" height="1600" loading="lazy" decoding="async">
    </picture>
  </figure>`;
const codeBlock = (text, t, label) => `
  <div class="code">
    <div class="code-label"><span>${label}</span><button class="copy" type="button" data-copy="${esc(text)}" data-done="${esc(t.cli.copied)}">${t.cli.copy}</button></div>
    <div class="code-body"><pre><code>${esc(text)}</code></pre></div>
  </div>`;

function chatMock(t) {
  const c = t.chat;
  return `
  <div class="chat" aria-hidden="true">
    <div class="chat-head">${platformIcon("telegram", 28)}<div><b>${c.group}</b><small>${c.members}</small></div></div>
    <div class="chat-body">
      <div class="msg in" data-step="1"><span class="who">${c.asker}</span><p>${c.ask}</p><span class="react">👀</span></div>
      <div class="msg out" data-step="2"><span class="who">Alex</span><p class="typing"><span class="dots"><i></i><i></i><i></i></span> ${c.thinking}</p><p class="answer" data-text="${esc(c.reply)}"></p></div>
      <div class="msg in" data-step="3"><span class="who">${c.follower}</span><p>${c.follow}</p></div>
      <div class="msg out" data-step="4"><span class="who">Alex</span><p>${c.reply2}</p></div>
    </div>
  </div>`;
}

function page(key) {
  const t = copy[key];
  const other = Object.entries(copy).filter(([k]) => k !== key);
  const lang = key;
  const langLinks = Object.entries(copy)
    .map(
      ([k, v]) =>
        `<a href="${v.path}" hreflang="${v.lang}" lang="${v.lang}"${k === key ? ' aria-current="page"' : ""}>${v.langName}</a>`,
    )
    .join("");
  const navLinks = Object.entries(t.nav)
    .map(([id, label]) => `<a href="#${id}">${label}</a>`)
    .join("");
  const dl = (os) =>
    `<div class="dl"><b>${t.downloadFor[os]}</b>${downloads[os].map(([label, href]) => `<a href="${href}">${label}</a>`).join("")}</div>`;
  const steps = t.how.steps
    .map(
      (s, i) => `
      <li class="step reveal">
        <div class="step-text"><span class="num">${i + 1}</span><h3>${s.title}</h3><p>${s.body}</p></div>
        ${s.img ? shot(s.img, lang, s.alt) : chatMock(t)}
      </li>`,
    )
    .join("");

  return `<!doctype html>
<html lang="${t.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t.title}</title>
<meta name="description" content="${esc(t.description)}">
<link rel="canonical" href="${ORIGIN}${t.path}">
${Object.values(copy)
  .map((v) => `<link rel="alternate" hreflang="${v.lang}" href="${ORIGIN}${v.path}">`)
  .join("\n")}
<link rel="alternate" hreflang="x-default" href="${ORIGIN}/">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1C1C1F" media="(prefers-color-scheme: dark)">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(t.title)}">
<meta property="og:description" content="${esc(t.description)}">
<meta property="og:url" content="${ORIGIN}${t.path}">
<meta property="og:image" content="${ORIGIN}/img/agent-${lang}-light.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/styles.css?v=${version}">
<script>document.documentElement.classList.add("js")</script>
<script defer src="/main.js?v=${version}"></script>
</head>
<body>
<header class="nav">
  <div class="wrap nav-inner">
    <a class="brand" href="${t.path}"><img src="/favicon.svg" alt="" width="26" height="26">Mingle</a>
    <nav class="nav-links">${navLinks}</nav>
    <div class="nav-end">
      <div class="langs">${langLinks}</div>
      <a class="icon-link" href="${REPO}" aria-label="GitHub"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 0-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.2-3.1 0-.4-.5-1.6.2-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.7 18.3 5 18.3 5c.7 1.6.2 2.8.1 3.2.8.8 1.2 1.9 1.2 3.1 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5Z"/></svg></a>
      <a class="btn btn-small btn-primary" href="#download">${t.download}</a>
    </div>
  </div>
</header>

<main>
<section class="hero">
  <div class="wrap">
    <p class="eyebrow rise">${t.hero.eyebrow} · v${version}</p>
    <h1 class="rise">${t.hero.title}</h1>
    <p class="lead rise">${t.hero.lead}</p>
    <div class="cta rise">
      <a class="btn btn-primary" data-os-download href="${downloads.mac[0][1]}"
         data-mac="${downloads.mac[0][1]}" data-windows="${downloads.windows[0][1]}" data-linux="${latest}/install.sh"
         data-label-mac="${t.downloadFor.mac}" data-label-windows="${t.downloadFor.windows}" data-label-linux="${t.downloadFor.linux}">${t.downloadFor.mac}</a>
      <a class="btn" href="#cli">${t.installTerminal}</a>
    </div>
    <p class="meta rise">${t.hero.meta}</p>
    <div class="hero-stage rise">
      ${shot("agent", lang, t.agent.alt, "hero-shot")}
      ${chatMock(t).replace('class="chat"', 'class="chat chat-float"')}
    </div>
  </div>
</section>

<section class="apps">
  <div class="wrap">
    <p class="apps-title">${t.apps.title}</p>
    <ul class="apps-row">
      ${platformOrder.map((id) => `<li>${platformIcon(id, 44)}<span>${t.platforms[id]}</span></li>`).join("")}
    </ul>
  </div>
</section>

<section id="how" class="section">
  <div class="wrap">
    <p class="eyebrow">${t.how.eyebrow}</p>
    <h2>${t.how.title}</h2>
    <ol class="steps">${steps}</ol>
  </div>
</section>

<section id="agent" class="section tint">
  <div class="wrap">
    <p class="eyebrow">${t.agent.eyebrow}</p>
    <h2>${t.agent.title}</h2>
    <p class="lead">${t.agent.lead}</p>
    <div class="memory">
      ${t.agent.memory
        .map(
          (m) => `
      <div class="chat reveal static" aria-hidden="true">
        <div class="chat-head">${platformIcon(m.app, 28)}<div><b>${m.chat}</b><small>${m.when}</small></div></div>
        <div class="chat-body">${m.msgs
          .map(([dir, who, text]) => `<div class="msg ${dir}"><span class="who">${who}</span><p>${text}</p></div>`)
          .join("")}</div>
      </div>`,
        )
        .join('<div class="memory-link" aria-hidden="true">→</div>')}
    </div>
    <ul class="grid grid-4">
      ${t.agent.points.map(([h, p]) => `<li class="card reveal"><h3>${h}</h3><p>${p}</p></li>`).join("")}
    </ul>
  </div>
</section>

<section id="brains" class="section">
  <div class="wrap">
    <p class="eyebrow">${t.brains.eyebrow}</p>
    <h2>${t.brains.title}</h2>
    <p class="lead">${t.brains.lead}</p>
    <ul class="brains reveal">
      ${harnesses
        .map(
          ([id, name]) =>
            `<li><span class="brain-icon"><img class="on-light" src="/icons/${id}-light.svg" alt=""><img class="on-dark" src="/icons/${id}-dark.svg" alt=""></span>${name}</li>`,
        )
        .join("")}
    </ul>
    <p class="note">${t.brains.note}</p>
  </div>
</section>

<section id="privacy" class="section tint">
  <div class="wrap">
    <p class="eyebrow">${t.privacy.eyebrow}</p>
    <h2>${t.privacy.title}</h2>
    <ul class="grid grid-2">
      ${t.privacy.items.map(([h, p]) => `<li class="card reveal"><h3>${h}</h3><p>${p}</p></li>`).join("")}
    </ul>
    <p class="note">${t.privacy.note}</p>
  </div>
</section>

<section id="details" class="section">
  <div class="wrap">
    <p class="eyebrow">${t.details.eyebrow}</p>
    <h2>${t.details.title}</h2>
    <ul class="grid grid-3">
      ${t.details.items.map(([h, p]) => `<li class="card reveal"><h3>${h}</h3><p>${p}</p></li>`).join("")}
    </ul>
  </div>
</section>

<section id="cli" class="section tint">
  <div class="wrap">
    <p class="eyebrow">${t.cli.eyebrow}</p>
    <h2>${t.cli.title}</h2>
    <p class="lead">${t.cli.lead}</p>
    <div class="cli-grid">
      <div>
        ${codeBlock(installSh, t, t.cli.macLinux)}
        ${codeBlock(installPs, t, t.cli.windows)}
        ${codeBlock(fromSource, t, t.cli.source)}
      </div>
      <div class="terminal reveal" aria-label="mingle">
        <div class="window-bar" aria-hidden="true"><i></i><i></i><i></i></div>
        <pre><code>${t.cli.commands
          .map(
            ([cmd, note]) =>
              `<span class="prompt">$</span> ${esc(cmd)}${note ? `\n<span class="comment"># ${note}</span>` : ""}`,
          )
          .join("\n\n")}</code></pre>
      </div>
    </div>
    <aside class="for-agents reveal"><b>${t.cli.agentsTitle}</b> ${t.cli.agentsBody}</aside>
  </div>
</section>

<section id="download" class="section end">
  <div class="wrap">
    <img class="end-icon" src="/favicon.svg" alt="" width="64" height="64">
    <h2>${t.end.title}</h2>
    <p class="lead">${t.end.lead}</p>
    <div class="dls">${dl("mac")}${dl("windows")}${dl("linux")}</div>
    <p class="note">${t.end.unsigned} <a href="${REPO}/releases">${t.end.allReleases} →</a></p>
  </div>
</section>
</main>

<footer class="footer">
  <div class="wrap footer-inner">
    <div>© ${new Date().getFullYear()} Mingle · MIT</div>
    <nav><a href="${REPO}">GitHub</a><a href="${REPO}/releases">Releases</a><a href="${REPO}/blob/main/CHANGELOG.md">${t.footer.changelog}</a><a href="/llms.txt">llms.txt</a>${other
      .map(([, v]) => `<a href="${v.path}" lang="${v.lang}">${v.langName}</a>`)
      .join("")}</nav>
    <p class="disclaimer">${t.footer.disclaimer}</p>
  </div>
</footer>
</body>
</html>
`;
}

function llms() {
  const t = copy.en;
  const strip = (s) => s.replace(/<[^>]+>/g, "").replaceAll("&amp;", "&");
  return `# Mingle

> ${strip(t.description)}

Key facts:

- Website: ${ORIGIN}/ (English), ${ORIGIN}/zh/ (Chinese)
- Source: ${REPO} (MIT)
- Latest release: ${REPO}/releases/latest (v${version})
- Install on macOS or Linux: \`${installSh}\`
- Install on Windows (PowerShell): \`${installPs}\`
- Price: free. No account, no Mingle server, no telemetry.

## What it does

- You create an agent on your own computer: a name, a role (ROLE.md), a memory (MEMORY.md, notes/) and a home folder.
- A coding agent you already have installed and signed in to drives it: ${harnesses.map(([, n]) => n).join(", ")}. Tested end to end with Claude Code and Codex. Mingle never calls a model itself.
- The agent joins ${platformOrder.map((id) => t.platforms[id]).join(", ")} as a bot, through each app's official bot API. People message it directly or @ it in a group.
- One agent keeps one long-lived session and one memory across every chat app. There are no session commands; the owner can send /stop.
- It keeps tasks and reminders, shows progress (a reaction, then a live reply), sends and receives files, and reports back where it was asked.
- Managed from a desktop app (macOS, Windows, Linux; menu bar or tray, auto-update), a local web console on 127.0.0.1, or the \`mingle\` command.
- Bot credentials are stored only in the macOS Keychain, Windows DPAPI or the Linux Secret Service.

## Command line

Build from source (Node.js 24, pnpm): \`git clone ${REPO}.git && cd Mingle && pnpm install && pnpm build\`, then run \`node dist/cli/main.js\`.

- \`mingle start [--port 7419] [--no-open]\`: run Mingle and open the console
- \`mingle status\`: agents and their connections
- \`mingle harnesses\`: harnesses installed on this computer
- \`mingle agent create --name <n> --harness <id> [--model <m>] [--role <text> | --role-file <path>]\`
- \`mingle connect <agent> telegram\`: bot token on standard input
- Inside a session, agents use \`mingle message reply|send|read|search\`, \`mingle chat list|info\`, \`mingle file get\`, \`mingle task create|list|update\`, \`mingle reminder set|list|cancel\`, and \`mingle manual\` for their full guide.
- Add \`--json\` for machine-readable output.

## Docs

- [README](${REPO}#readme): status, install, quick start
- [Product design and architecture](${REPO}/blob/main/docs/spec.md) (Chinese)
- [Interface design](${REPO}/blob/main/DESIGN.md) (Chinese)
- [Changelog](${REPO}/blob/main/CHANGELOG.md)
- [Releasing](${REPO}/blob/main/docs/releasing.md)

## Common questions

- **Does my data go to a Mingle server?** No. There is none. Messages still pass through the chat app and your model provider.
- **Do I need an API key?** No, if your harness is signed in with a subscription. An API key set for Claude Code or Codex also works.
- **Is the app signed?** Not yet. On macOS, allow it in System Settings → Privacy & Security; on Windows, choose More info → Run anyway.
`;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "zh"), { recursive: true });
for (const asset of ["img", "icons", "styles.css", "main.js", "favicon.svg", "_headers", "robots.txt"])
  cpSync(join(SITE, asset), join(OUT, asset), { recursive: true });
writeFileSync(join(OUT, "index.html"), page("en"));
writeFileSync(join(OUT, "zh/index.html"), page("zh"));
writeFileSync(join(OUT, "llms.txt"), llms());
writeFileSync(
  join(OUT, "404.html"),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found · Mingle</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/styles.css?v=${version}"></head><body><main class="section end"><div class="wrap"><img class="end-icon" src="/favicon.svg" alt="" width="64" height="64"><h2>This page isn't here.</h2><p class="lead"><a href="/">mingle.build</a> · <a href="/zh/">中文</a></p></div></main></body></html>\n`,
);
writeFileSync(
  join(OUT, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${Object.values(
    copy,
  )
    .map((v) => `  <url><loc>${ORIGIN}${v.path}</loc></url>`)
    .join("\n")}\n</urlset>\n`,
);
console.log(`site in ${OUT}`);
