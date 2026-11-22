// Bilingual harness landing pages (/claude-code/, /codex/, /opencode/, /kimi-code/)
// and high-intent GEO reference pages (/security/, /compare/) for mingle.build.
// Keep English and Chinese in step, and keep every claim grounded in the codebase.

export const harnessPageOrder = ["claude-code", "codex", "opencode", "kimi-code"];

export const harnessSlugById = {
  claude: "claude-code",
  codex: "codex",
  opencode: "opencode",
  kimi: "kimi-code",
};

export const topicsUi = {
  en: {
    backHome: "Overview",
    breadcrumbHome: "Mingle",
    securityNav: "Security",
    compareNav: "Compare",
    setupEyebrow: "Quick start",
    setupTitle: "Up and running in a minute.",
    worksEyebrow: "Why Mingle",
    appsEyebrow: "Chat apps",
    appsTitle: "Use it in every chat app you already have.",
    appsLead:
      "Connect one or more platforms to the same local agent—one long-lived session and one shared memory across all of them.",
    otherHarnessesEyebrow: "Other verified harnesses",
    otherHarnessesTitle: "Switch brains anytime.",
    otherHarnessesLead:
      "Mingle supports 14 coding agent harnesses through OAR and lets each agent choose or change its harness and model anytime.",
    faqEyebrow: "Questions",
    faqTitle: "Common questions.",
    seeAll: "See full overview",
    matrixEyebrow: "10 platforms at a glance",
    matrixTitle: "Channel capability matrix.",
    matrixLead:
      "Every adapter connects outbound from your machine through the platform's official bot API (or local Messages on macOS)—no webhook server or cloud bridge.",
  },
  zh: {
    backHome: "总览",
    breadcrumbHome: "Mingle",
    securityNav: "架构与安全",
    compareNav: "方案对比",
    setupEyebrow: "快速开始",
    setupTitle: "一分钟接好，马上开聊。",
    worksEyebrow: "为什么用 Mingle",
    appsEyebrow: "支持的聊天软件",
    appsTitle: "在每一个你已经在用的聊天软件里调用它。",
    appsLead: "同一个本机 Agent 可以同时接入多个平台——共享同一个长期会话和同一份本地记忆。",
    otherHarnessesEyebrow: "其他端到端验证的 Harness",
    otherHarnessesTitle: "随时切换大脑。",
    otherHarnessesLead: "Mingle 通过 OAR 支持 14 款 coding agent harness，每个 Agent 都可以随时切换大脑和模型。",
    faqEyebrow: "常见问题",
    faqTitle: "常见疑问。",
    seeAll: "查看完整介绍",
    matrixEyebrow: "10 个平台一览",
    matrixTitle: "渠道能力与接入协议矩阵。",
    matrixLead:
      "每个渠道均由你本机主动发起官方机器人接口连接（Mac 上 iMessage 直连本机「信息」App）——无需公网 webhook 或云端中转。",
  },
};

export const harnessPages = {
  en: {
    "claude-code": {
      icon: "claude",
      harnessId: "claude",
      name: "Claude Code",
      title: "Use Claude Code from Slack, Telegram, WeChat & iMessage Locally · Mingle",
      description:
        "Bring your local Claude Code into Slack, Discord, Telegram, WeChat, Feishu, GitHub and iMessage. Reuses your existing Claude subscription or API key—no server, no extra bill.",
      eyebrow: "Mingle + Claude Code",
      h1: "Claude Code in every chat app.<br><span>On your own computer.</span>",
      lead: "Keep Claude Code running on your own machine and talk to it from Slack, Telegram, Discord, WeChat, Feishu, GitHub or iMessage. Reuses your existing subscription or API key with zero cloud server.",
      metaNote: "Tested end to end · Reuses your Claude subscription or API key · Zero server",
      cliCmd: 'mingle agent create --name Alex --harness claude --role "You help with my repos and daily tasks."',
      steps: [
        [
          "Install Mingle on macOS, Windows or Linux",
          "Download the menu-bar / tray desktop app or run the one-line terminal installer. Mingle detects your local Claude Code installation and quota automatically—or installs and signs in to it from the console.",
        ],
        [
          "Create an agent driven by Claude Code",
          "Give the agent a name and a plain-text role (ROLE.md), then pick Claude Code and your preferred model. Each agent keeps its own home folder, MEMORY.md and notes/ on your disk.",
        ],
        [
          "Connect your chat apps and message from anywhere",
          "Scan a QR code for WeChat, Feishu, WeCom, DingTalk or QQ, paste a bot token for Slack, Discord or Telegram, link GitHub, or enable iMessage on macOS. Message your local Claude Code right from your phone.",
        ],
      ],
      worksTitle: "Everything Claude Code can do, reachable from your phone and team chats.",
      highlights: [
        [
          "Your existing Claude subscription or API key",
          "Mingle never calls an LLM API itself and adds no token markup. It drives the Claude Code harness you already signed in to on your computer and shows remaining quota in Settings.",
        ],
        [
          "One persistent session across 10 platforms",
          "Unlike isolated chatbots, one Mingle agent keeps one long-lived Claude Code session and one memory across Slack, WeChat, Feishu, Discord, Telegram, GitHub and iMessage.",
        ],
        [
          "Parallel background work without blocking",
          "Hand Claude Code a bug fix or repo refactor in a group chat: it runs on the side (up to 3 concurrent jobs) in a native thread while still answering quick questions in seconds.",
        ],
        [
          "Full local access with owner guardrails",
          "Because Claude Code stays on your computer, it can read your local files and tools directly—while credentials stay in your OS keychain and public apps require owner approval.",
        ],
      ],
      faq: [
        [
          "Do I need an Anthropic API key to use Claude Code with Mingle?",
          "No. If Claude Code is already signed in with your Claude subscription, Mingle drives it directly. An API key configured for Claude Code works too.",
        ],
        [
          "Can I control my local Claude Code from my phone when I am away from my desk?",
          "Yes. Leave Mingle running on your Mac, Windows PC or Linux machine and message your agent from Telegram, Slack, Discord, WeChat, Feishu or iMessage on your phone.",
        ],
        [
          "How is this different from the Claude mobile app?",
          "The Claude mobile app cannot run inside your team's Slack/Feishu/Discord groups, touch files on your computer, monitor local shell checks, or share one persistent workspace across chat apps. Mingle bridges your local Claude Code directly into your existing chats.",
        ],
        [
          "Does Mingle send my Claude Code transcripts to a Mingle server?",
          "No. There is no Mingle server, no account and no telemetry. Messages go only between your chat app, Mingle on your computer (127.0.0.1), and your local Claude Code harness.",
        ],
      ],
    },
    codex: {
      icon: "codex",
      harnessId: "codex",
      name: "Codex",
      title: "Use OpenAI Codex from Slack, Discord, Telegram & WeChat Locally · Mingle",
      description:
        "Connect your local Codex CLI coding agent to Slack, Discord, Telegram, WeChat, Feishu, GitHub and iMessage. Runs on your computer with your existing ChatGPT/Codex subscription or API key.",
      eyebrow: "Mingle + Codex",
      h1: "Codex in every chat app.<br><span>On your own computer.</span>",
      lead: "Bring the Codex coding agent on your machine into Slack, Discord, Telegram, WeChat, Feishu, GitHub and iMessage. One agent, one memory, parallel background tasks, and zero cloud server.",
      metaNote: "Tested end to end · Reuses your Codex subscription or API key · Zero server",
      cliCmd: 'mingle agent create --name Alex --harness codex --role "You review PRs and fix bugs in my workspace."',
      steps: [
        [
          "Install Mingle locally",
          "Download the desktop app or install from your terminal. Mingle automatically detects Codex on your machine (and can install, sign in to, or update it right from the console).",
        ],
        [
          "Create a Codex-powered agent",
          "Pick Codex as the agent's brain, choose your model, and write a short role description. Memory stays in plain local files (ROLE.md, MEMORY.md, notes/).",
        ],
        [
          "Connect Slack, GitHub, Telegram, WeChat and more",
          "Connect any combination of the 10 supported platforms over their official bot APIs—no public webhook, no VPS, and no ngrok needed.",
        ],
      ],
      worksTitle: "Your local Codex, always reachable in chat and GitHub PRs.",
      highlights: [
        [
          "Uses your existing Codex sign-in or API key",
          "Mingle drives your local Codex installation through OAR with zero extra model billing, and lets you see Codex quota right inside the console.",
        ],
        [
          "GitHub PRs + team chats in one memory",
          "@-mention your Codex agent in a GitHub PR review thread and follow up in Slack, Discord or Telegram—it remembers both because it is one local agent.",
        ],
        [
          "Works on the side while answering fast",
          "Kick off a longer coding task and Codex works in parallel (up to 3 tasks at once), posting live progress in threads while still answering quick questions immediately.",
        ],
        [
          "Local-first security by default",
          "No Mingle server, no telemetry, local 127.0.0.1 console, OS Keychain credential storage, and owner approval before strangers on public bots can spend your quota.",
        ],
      ],
      faq: [
        [
          "Does Mingle work with my ChatGPT / Codex subscription or only an OpenAI API key?",
          "Both work. Mingle drives the Codex harness you already have signed in locally, whether authenticated via subscription or API key.",
        ],
        [
          "Can I switch an agent between Codex and Claude Code later?",
          "Yes. Every agent's memory lives in plain local files (ROLE.md, MEMORY.md, notes/), and you can switch its harness or model in the console anytime.",
        ],
        [
          "Can Codex respond to @mentions in GitHub issues and pull requests?",
          "Yes. Connect Mingle's GitHub channel using a dedicated GitHub account for the agent—Mingle polls notifications locally with ETag caching and only responds to repository owners, members and collaborators.",
        ],
      ],
    },
    opencode: {
      icon: "opencode",
      harnessId: "opencode",
      name: "OpenCode",
      title: "Connect OpenCode to Slack, Discord, Telegram, Feishu & WeChat · Mingle",
      description:
        "Put your local OpenCode coding agent into Slack, Discord, Telegram, WeChat, Feishu, GitHub and iMessage with Mingle. Open source (MIT), local-first, zero server.",
      eyebrow: "Mingle + OpenCode",
      h1: "OpenCode in every chat app.<br><span>Open source, no server.</span>",
      lead: "Pair open-source OpenCode with MIT-licensed Mingle to bring your local coding agent into Slack, Discord, Telegram, WeChat, Feishu, GitHub and iMessage—with zero cloud bridge.",
      metaNote: "Tested end to end · MIT open source · Any provider configured in OpenCode",
      cliCmd: 'mingle agent create --name Alex --harness opencode --role "You help maintain our open-source repos."',
      steps: [
        [
          "Install Mingle alongside OpenCode",
          "Run the desktop app or CLI installer on macOS, Windows or Linux. Mingle discovers OpenCode on your computer automatically and lists its available models.",
        ],
        [
          "Create an agent backed by OpenCode",
          "Give it a name, a role and a local home folder. OpenCode runs with whichever model provider you already configured locally.",
        ],
        [
          "Join your favorite chat apps without a server",
          "Connect Discord, Slack, Telegram, Feishu, WeChat, GitHub or iMessage over official local connections—no webhook host or third-party relay.",
        ],
      ],
      worksTitle: "An end-to-end open-source stack from terminal to chat.",
      highlights: [
        [
          "Bring any model OpenCode supports",
          "Mingle delegates model calls entirely to OpenCode, so whatever providers, keys or local models you configure in OpenCode work automatically across all 10 chat platforms.",
        ],
        [
          "One shared memory across every channel",
          "Your OpenCode agent keeps one ROLE.md, MEMORY.md and notes/ folder whether you talk to it in Discord, Slack, Telegram, Feishu or GitHub.",
        ],
        [
          "Reminders with local shell checks",
          "Set a reminder with `--check <command>` and Mingle runs the check locally, waking OpenCode only when CI, a release or a web page actually changes.",
        ],
        [
          "MIT licensed, zero telemetry",
          "Both Mingle and OpenCode keep your workflow transparent, auditable and strictly on your own machine.",
        ],
      ],
      faq: [
        [
          "Has Mingle been tested end to end with OpenCode?",
          "Yes. OpenCode is one of the four harnesses tested end to end alongside Claude Code, Codex and Kimi Code.",
        ],
        [
          "Does Mingle restrict which LLM providers OpenCode can use?",
          "No. Mingle drives OpenCode through OAR and lets you pick from the models OpenCode exposes on your machine.",
        ],
        [
          "Do I need a VPS to connect OpenCode to Discord or Telegram?",
          "No. Mingle runs on your own computer and connects outbound over the official Discord Gateway and Telegram long-polling APIs.",
        ],
      ],
    },
    "kimi-code": {
      icon: "kimi",
      harnessId: "kimi",
      name: "Kimi Code",
      title: "Connect Kimi Code to WeChat, Feishu, DingTalk, Slack & Telegram · Mingle",
      description:
        "Bring your local Kimi Code agent into WeChat, Feishu, WeCom, DingTalk, QQ, Slack, Discord, Telegram, GitHub and iMessage. QR-code setup, one memory, zero cloud server.",
      eyebrow: "Mingle + Kimi Code",
      h1: "Kimi Code in every chat app.<br><span>Local-first, no server.</span>",
      lead: "Connect Kimi Code running on your own computer to WeChat, Feishu, WeCom, DingTalk, QQ, Slack, Discord, Telegram, GitHub and iMessage—with one memory and zero server.",
      metaNote: "Tested end to end · Reuses your Kimi Code login · Zero server",
      cliCmd: 'mingle agent create --name Alex --harness kimi --role "You help with engineering and research."',
      steps: [
        [
          "Install Mingle on your computer",
          "Launch the Mingle desktop app or install via CLI. Mingle detects Kimi Code on your machine and can install, sign in to, or update it from the console.",
        ],
        [
          "Create an agent powered by Kimi Code",
          "Set a name and role, choose Kimi Code as the harness, and keep its memory in local Markdown files (ROLE.md, MEMORY.md, notes/).",
        ],
        [
          "Scan a QR code to join WeChat, Feishu, WeCom, DingTalk or QQ",
          "Or paste a token for Slack, Discord and Telegram. Your local Kimi Code agent is live in minutes with zero public server.",
        ],
      ],
      worksTitle: "Local Kimi Code across Chinese and global chat apps.",
      highlights: [
        [
          "Native QR-code setup for WeChat, Feishu, WeCom, DingTalk & QQ",
          "Connect official bots in under a minute without configuring public callback URLs, webhooks or reverse proxies.",
        ],
        [
          "One Kimi Code agent across work and personal chats",
          "Ask in WeChat what the team decided in Feishu or DingTalk earlier today—it is the same agent sharing one local memory.",
        ],
        [
          "Parallel tasks with live progress cards",
          "Feishu and DingTalk stream live progress cards while Kimi Code works on longer coding tasks on the side, leaving quick questions unblocked.",
        ],
        [
          "Zero extra billing or cloud relay",
          "Mingle is free and MIT open source. Your Kimi Code credentials, bot tokens and chat context never leave your machine to a Mingle server.",
        ],
      ],
      faq: [
        [
          "Is Kimi Code tested end to end with Mingle?",
          "Yes. Kimi Code is one of Mingle's four end-to-end verified harnesses alongside Claude Code, Codex and OpenCode.",
        ],
        [
          "Can Kimi Code run in both Feishu/WeChat and Slack/GitHub at the same time?",
          "Yes. One Mingle agent can attach as many chat apps as you want and keeps a single long-lived session and shared memory across all of them.",
        ],
        [
          "Do I need a server to connect Kimi Code to Feishu or WeChat?",
          "No. Both Feishu (official SDK long connection) and WeChat (official bot long polling) connect outbound straight from your computer.",
        ],
      ],
    },
  },
  zh: {
    "claude-code": {
      icon: "claude",
      harnessId: "claude",
      name: "Claude Code",
      title: "把 Claude Code 接进微信、飞书、Slack、Telegram 与 iMessage · Mingle",
      description:
        "在本机把 Claude Code 接进微信、飞书、企业微信、钉钉、QQ、Slack、Discord、Telegram、GitHub 与 iMessage。直接复用现有订阅或 API key，无服务器、不加收模型费。",
      eyebrow: "Mingle · Claude Code",
      h1: "把 Claude Code 请进<br><span>你已经在用的每个聊天软件。</span>",
      lead: "让 Claude Code 继续跑在你自己的电脑上，随时从微信、飞书、Slack、Telegram、Discord、GitHub 或 iMessage 给它派活。直接复用现有订阅或 API key，没有云服务器。",
      metaNote: "端到端已验证 · 直接复用现有 Claude 订阅或 API key · 零服务器",
      cliCmd: 'mingle agent create --name Alex --harness claude --role "你帮我处理代码仓库和日常事务。"',
      steps: [
        [
          "在电脑上安装 Mingle",
          "下载 macOS / Windows / Linux 桌面应用，或一行终端命令安装。Mingle 会自动发现本机已安装的 Claude Code 并显示剩余额度；没装也可以在控制台直接安装和登录。",
        ],
        [
          "创建一个由 Claude Code 驱动的 Agent",
          "给它起个名字、用一句话写清角色（ROLE.md），选定 Claude Code 和模型。它的记忆（MEMORY.md、notes/）全部留在你本机文件夹里。",
        ],
        [
          "连上你的聊天软件，手机随时派活",
          "微信、飞书、企业微信、钉钉、QQ 手机扫码即连；Slack、Discord、Telegram 贴入 token；GitHub 验证码授权；Mac 上还能直接开 iMessage 自聊。",
        ],
      ],
      worksTitle: "本机 Claude Code 的全部能力，装进手机和团队群聊。",
      highlights: [
        [
          "直接用你已有的 Claude 订阅或 API key",
          "Mingle 自己不调用模型、不加收任何 token 差价，直接驱动你电脑上已登录的 Claude Code，并在设置里一眼查看额度。",
        ],
        [
          "10 个平台共用一个长期会话和一份记忆",
          "不是每个软件里各建一个孤立机器人：微信、飞书、Slack、Discord、Telegram、GitHub、iMessage 里都是同一个 Claude Code Agent。",
        ],
        [
          "长任务后台并行，快问照样秒回",
          "在群里丢给它一个修 bug 或重构任务，它在旁边并行处理（最多同时做 3 件）并把进度发在话题里，同时群里其他人的简单问题照样几秒回复。",
        ],
        [
          "保留本机全量能力，同时有完整权限护栏",
          "Claude Code 留在你的电脑上，可直接读写本地代码和工具；所有机器人密钥只存系统钥匙串，公开平台陌生人默认需 owner 审批。",
        ],
      ],
      faq: [
        [
          "用 Mingle 接 Claude Code 必须买 Anthropic API key 吗？",
          "不需要。如果你的 Claude Code 已经用 Claude 订阅账号登录好，Mingle 会直接驱动它；配置了 API key 也同样支持。",
        ],
        [
          "人不在电脑前，能用手机远程给本机 Claude Code 派活吗？",
          "可以。电脑上保持 Mingle 在菜单栏或托盘运行，你出门在外直接用手机里的微信、飞书、Telegram、Slack 或 iMessage 给它发消息即可。",
        ],
        [
          "这和直接用 Claude 手机 App 有什么区别？",
          "Claude 手机 App 无法加入你公司的飞书/Slack/企微群，无法直接读写你电脑上的本地代码仓库，也无法跨聊天软件共享同一份工作记忆。Mingle 是把你本机的 Claude Code 直接接进你日常沟通的聊天软件。",
        ],
        [
          "我的 Claude Code 对话和代码会经过 Mingle 服务器吗？",
          "不会。Mingle 没有服务器、没有账号、没有遥测。消息只在你的聊天软件、本机 Mingle（127.0.0.1）和你的 Claude Code 之间流转。",
        ],
      ],
    },
    codex: {
      icon: "codex",
      harnessId: "codex",
      name: "Codex",
      title: "把 OpenAI Codex 接进微信、飞书、Slack、Discord 与 Telegram · Mingle",
      description:
        "在本机把 Codex CLI 接进微信、飞书、Slack、Discord、Telegram、GitHub 与 iMessage。复用已有 ChatGPT / Codex 订阅或 API key，本地运行，无需云服务器。",
      eyebrow: "Mingle · Codex",
      h1: "把 Codex 请进<br><span>你已经在用的每个聊天软件。</span>",
      lead: "把运行在你电脑上的 Codex 接入微信、飞书、Slack、Discord、Telegram、GitHub 和 iMessage。一个 Agent，一份记忆，多任务并行，零云服务器。",
      metaNote: "端到端已验证 · 直接复用已有 Codex 订阅或 API key · 零服务器",
      cliCmd: 'mingle agent create --name Alex --harness codex --role "你帮我审 PR 和修复项目里的 bug。"',
      steps: [
        [
          "在本机安装 Mingle",
          "下载桌面端或用终端脚本安装。Mingle 会自动检测本机的 Codex，并支持直接在控制台里安装、登录和更新。",
        ],
        [
          "创建由 Codex 驱动的 Agent",
          "选择 Codex 作为大脑并选定模型，写一句角色说明。Agent 的记忆以纯文本 Markdown 文件留在你本机（ROLE.md、MEMORY.md、notes/）。",
        ],
        [
          "接入 Slack、GitHub、飞书、微信等平台",
          "按需接入任意数量的支持平台，全部通过官方机器人接口由本机直连，无需公网 webhook、VPS 或内网穿透。",
        ],
      ],
      worksTitle: "让本机 Codex 随时待命于群聊和 GitHub PR。",
      highlights: [
        [
          "复用现有 Codex 订阅或 API key",
          "Mingle 通过 OAR 直接驱动你本机的 Codex，不另收任何模型费用，控制台里也能直接看 Codex 剩余额度。",
        ],
        [
          "GitHub PR 与工作群共享上下文",
          "在 GitHub PR 行内评审里 @ Codex，回头在飞书、Slack 或微信里接着问进展——它们面对的是同一个本地 Agent。",
        ],
        ["长活后台跑，主群不卡壳", "支持最多 3 件事并行执行，在话题或卡片里实时刷新进度，简单提问几秒就能收到回复。"],
        [
          "本地优先的安全边界",
          "没有 Mingle 服务器、没有遥测，控制台仅监听 127.0.0.1，凭据只存系统钥匙串，公开机器人默认开启陌生人审批。",
        ],
      ],
      faq: [
        [
          "Mingle 支持 ChatGPT / Codex 订阅，还是只能用 OpenAI API key？",
          "两者都支持。Mingle 直接驱动你本机已登录的 Codex，无论是订阅登录还是 API key 都能用。",
        ],
        [
          "以后可以把同一个 Agent 从 Codex 切换成 Claude Code 吗？",
          "可以。Agent 的记忆保存在本地纯文本文件（ROLE.md、MEMORY.md、notes/）里，随时可以在控制台切换 harness 或模型。",
        ],
        [
          "可以用 Codex 在 GitHub Issue 和 PR 里自动响应 @ 吗？",
          "可以。在 Mingle 里连接 GitHub 渠道后，本机会通过 ETag 轮询官方通知 API，只响应仓库 OWNER、MEMBER 和 COLLABORATOR 的 @。",
        ],
      ],
    },
    opencode: {
      icon: "opencode",
      harnessId: "opencode",
      name: "OpenCode",
      title: "把 OpenCode 接进微信、飞书、Slack、Discord 与 Telegram · Mingle",
      description:
        "用 MIT 开源的 Mingle 把本机 OpenCode 接进微信、飞书、Slack、Discord、Telegram、GitHub 与 iMessage。全栈开源，本地直连，无服务器。",
      eyebrow: "Mingle · OpenCode",
      h1: "把 OpenCode 请进<br><span>你的每一个聊天软件。</span>",
      lead: "把开源的 OpenCode 和 MIT 协议的 Mingle 组合起来，让本机 coding agent 直接入驻微信、飞书、Slack、Discord、Telegram、GitHub 与 iMessage，全程零云端中转。",
      metaNote: "端到端已验证 · 全栈开源（MIT）· 支持 OpenCode 配置的任意模型",
      cliCmd: 'mingle agent create --name Alex --harness opencode --role "你帮我维护开源仓库和文档。"',
      steps: [
        [
          "在装有 OpenCode 的电脑上安装 Mingle",
          "在 macOS、Windows 或 Linux 上启动 Mingle，它会自动识别本机的 OpenCode 及已配置的模型列表。",
        ],
        [
          "创建由 OpenCode 驱动的 Agent",
          "设置名字、角色和主目录，OpenCode 会直接使用你本机已经配置好的模型提供商和密钥。",
        ],
        [
          "零服务器接进你常用的聊天软件",
          "通过官方机器人通道接入飞书、微信、Discord、Slack、Telegram、GitHub 或 iMessage，不需要搭 webhook 服务器。",
        ],
      ],
      worksTitle: "从终端到聊天软件，全链路开源可控。",
      highlights: [
        [
          "沿用你在 OpenCode 里配好的任意模型",
          "Mingle 不干预模型来源，OpenCode 上能跑的云端模型或本地模型都能无缝服务于全部 10 个聊天平台。",
        ],
        [
          "跨软件共享一份本地 Markdown 记忆",
          "无论你在 Discord、Slack、Telegram、飞书还是 GitHub 找它，面对的都是同一个共享 ROLE.md 和 MEMORY.md 的 Agent。",
        ],
        [
          "带本地 Shell 检查的智能提醒",
          "用 `--check <command>` 挂一个本地检查命令，Mingle 只在 CI、网页或新版本真正发生变化时才唤醒 OpenCode，不浪费额度。",
        ],
        ["MIT 开源，零遥测", "代码公开可审计，没有账号体系、没有云端服务端，数据留在你自己的硬盘上。"],
      ],
      faq: [
        [
          "Mingle 已经和 OpenCode 端到端跑通了吗？",
          "是的。OpenCode 与 Claude Code、Codex、Kimi Code 一起，都是 Mingle 已端到端验证通过的核心 harness。",
        ],
        [
          "Mingle 会限制 OpenCode 使用哪家大模型吗？",
          "不会。Mingle 通过 OAR 驱动 OpenCode，你在 OpenCode 里配好什么模型和 provider 就能直接用。",
        ],
        [
          "把 OpenCode 接到 Discord 或 Telegram 需要买云服务器吗？",
          "不需要。Mingle 在本机主动连向 Discord 官方 Gateway 和 Telegram 长轮询接口，零服务器即可稳定运行。",
        ],
      ],
    },
    "kimi-code": {
      icon: "kimi",
      harnessId: "kimi",
      name: "Kimi Code",
      title: "把 Kimi Code 接进微信、飞书、企业微信、钉钉与 Slack · Mingle",
      description:
        "扫码将本机 Kimi Code 接进微信、飞书、企业微信、钉钉、QQ、Slack、Discord、Telegram、GitHub 与 iMessage。本地直连，无服务器，跨软件共享记忆。",
      eyebrow: "Mingle · Kimi Code",
      h1: "把 Kimi Code 请进<br><span>微信、飞书和所有聊天软件。</span>",
      lead: "把运行在你电脑上的 Kimi Code 接进微信、飞书、企业微信、钉钉、QQ、Slack、Discord、Telegram、GitHub 与 iMessage。一份记忆，没有服务器。",
      metaNote: "端到端已验证 · 复用已有 Kimi Code 登录 · 零服务器",
      cliCmd: 'mingle agent create --name Alex --harness kimi --role "你帮我处理研发任务和资料整理。"',
      steps: [
        [
          "在本机安装 Mingle",
          "启动桌面应用或用终端命令安装。Mingle 会自动检测本机的 Kimi Code，也支持在控制台直接安装、登录和更新。",
        ],
        [
          "创建由 Kimi Code 驱动的 Agent",
          "写好名字和角色、选择 Kimi Code，记忆以纯文本保存在本机 ROLE.md、MEMORY.md 和 notes/ 中。",
        ],
        [
          "扫码接进微信、飞书、企业微信、钉钉或 QQ",
          "也可贴入 token 接入 Slack、Discord、Telegram。无需公网回调域名或云服务器，几分钟即可开聊。",
        ],
      ],
      worksTitle: "一套本机 Kimi Code，同时覆盖国内与海外常用 IM。",
      highlights: [
        [
          "微信、飞书、企微、钉钉、QQ 全部官方扫码直连",
          "不用自己买云主机配公网回调，也不用折腾内网穿透，手机扫一下二维码即完成接入。",
        ],
        [
          "工作群和私人微信共用一份记忆",
          "同一个 Kimi Code Agent 同时在飞书/钉钉群和你的微信里，出门在微信也能直接问今天工作群里的结论。",
        ],
        ["流式进度卡片与后台并行处理", "在飞书和钉钉里支持流式 AI 卡片与话题并行，长任务慢慢跑，简单问题几秒秒回。"],
        [
          "零额外收费，零云端中转",
          "Mingle 免费且 MIT 开源，你的 Kimi Code 登录态、机器人密钥和聊天记录都不会经过任何 Mingle 服务器。",
        ],
      ],
      faq: [
        [
          "Kimi Code 已经和 Mingle 做过端到端验证吗？",
          "是的。Kimi Code 与 Claude Code、Codex、OpenCode 同为 Mingle 端到端验证通过的核心 harness。",
        ],
        [
          "同一个 Kimi Code Agent 可以同时接飞书、微信和 Slack / GitHub 吗？",
          "可以。一个 Agent 可以同时绑定任意多个聊天软件，并且共用同一个长期会话与本地记忆。",
        ],
        [
          "用 Kimi Code 接飞书或微信需要公网服务器吗？",
          "不需要。飞书走官方 SDK 长连接，微信走官方机器人长轮询，全部由你本机主动发起连接。",
        ],
      ],
    },
  },
};

export const securityPage = {
  en: {
    path: "/security/",
    title: "Architecture & Security: Local-First, Zero Server · Mingle",
    description:
      "How Mingle keeps your coding agent and chat data private: no Mingle server, outbound official bot APIs, 127.0.0.1 local console, OS Keychain credentials, owner approval gates, and MIT open-source code.",
    eyebrow: "Architecture & Security",
    h1: "Runs on your computer.<br><span>No Mingle server to trust.</span>",
    lead: "Mingle is a local runtime on your own machine—there is no Mingle backend, no cloud bridge, no user account, and no telemetry. Here is the exact data flow, credential model, and access control architecture.",
    metaNote: "127.0.0.1 only · OS Keychain / DPAPI / Secret Service · Zero telemetry · MIT",
    factsEyebrow: "Verifiable facts",
    factsTitle: "Security model at a glance.",
    factsHeaders: ["Dimension", "How Mingle works"],
    factsRows: [
      [
        "Mingle cloud server",
        "None. There is no Mingle server, no relay, no Mingle account, and no analytics or telemetry.",
      ],
      [
        "Message path",
        "Chat app official API ↔ Mingle on your computer ↔ your local coding agent harness ↔ your model provider. Mingle never sits in the cloud in between.",
      ],
      [
        "Inbound ports / public URL",
        "None required. All 9 network channels connect outbound (WebSocket, Stream, long polling or ETag REST polling); iMessage reads your local macOS Messages database.",
      ],
      ["Local console & admin API", "Listens strictly on 127.0.0.1 (default port 7419). Never bound to 0.0.0.0."],
      [
        "Credential storage",
        "Bot tokens and app secrets are stored exclusively in macOS Keychain, Windows DPAPI, or Linux Secret Service—never in plaintext config files.",
      ],
      [
        "Agent data on disk",
        "Each agent's home directory holds plain Markdown files: ROLE.md, MEMORY.md and notes/. Runtime state and logs live in ~/.mingle (MINGLE_HOME).",
      ],
      [
        "Owner binding & public bots",
        "QR channels bind ownership to whoever completes the scan; token channels require a 6-digit claim code from the local console. Public bots (Telegram, Discord, QQ) hold unknown users and groups for owner approval.",
      ],
      [
        "GitHub anti-abuse filter",
        "Checks author_association on every notification and only wakes the agent for repository OWNER, MEMBER or COLLABORATOR accounts; strangers on public repos are ignored.",
      ],
      [
        "Emergency stop & auditability",
        "Owners can send /stop in chat to halt the current turn immediately. The entire codebase is MIT open source on GitHub, with private security advisories enabled.",
      ],
    ],
    pillarsEyebrow: "Design boundaries",
    pillarsTitle: "Four layers that keep your machine and quota safe.",
    pillars: [
      [
        "Zero cloud relay, zero exposed ports",
        "Because Mingle connects outbound via official SDK WebSockets, long polling and ETag polling, you never have to run ngrok, rent a VPS, open firewall ports or trust a third-party cloud bridge with company chats.",
      ],
      [
        "OS-native secret storage",
        "Every Slack, Discord, Telegram, Feishu, WeChat, WeCom, DingTalk, QQ and GitHub credential is stored in the macOS Keychain, Windows DPAPI or Linux Secret Service—never serialized into JSON or YAML on disk.",
      ],
      [
        "Strict trust gates on public platforms",
        "Nobody can silently drain your Claude Code or Codex subscription. Public bots (Telegram, Discord, QQ) quarantine new people and groups until you approve them; GitHub ignores non-collaborators; iMessage only reads your self-chat.",
      ],
      [
        "Plain-text memory you own and can inspect",
        "Your agent's instructions and long-term memory are ordinary Markdown files (ROLE.md, MEMORY.md, notes/) in a folder you choose. Edit, back up, version-control or delete them anytime.",
      ],
    ],
    faq: [
      [
        "Does any chat message, file, or code snippet pass through a Mingle server?",
        "No. There is no Mingle server at all. Messages travel directly between your chat platform (e.g., Slack or Feishu), your computer running Mingle, and whichever model provider your local coding agent harness uses.",
      ],
      [
        "Where are bot tokens stored on macOS, Windows, and Linux?",
        "Tokens are stored only in the operating system secret store: macOS Keychain on Mac, Windows DPAPI on Windows, and Secret Service on Linux.",
      ],
      [
        "How does Mingle prevent strangers from spending my Claude Code or Codex quota?",
        "Ownership is claimed via QR scan or a 6-digit code shown only in your local 127.0.0.1 console. On public apps (Telegram, Discord, QQ), unknown users and groups wait for explicit owner approval before the agent runs; on GitHub, only repo OWNER, MEMBER and COLLABORATOR mentions are accepted.",
      ],
      [
        "Is the desktop app signed, and how do I report a vulnerability?",
        "The macOS app is signed and notarized by Apple; check each version's GitHub release notes for current Windows/Linux signing status. Report security issues privately via GitHub Security Advisories on earayu/Mingle rather than a public issue.",
      ],
    ],
  },
  zh: {
    path: "/zh/security/",
    title: "架构与安全：本地运行、零服务器与权限隔离 · Mingle",
    description:
      "Mingle 的本地安全架构说明：无 Mingle 服务端、纯本机出站官方接口、控制台仅监听 127.0.0.1、系统钥匙串存凭据、公开平台陌生人审批与 MIT 开源可审计。",
    eyebrow: "架构与安全",
    h1: "完全跑在你自己的电脑上，<br><span>没有需要信任的 Mingle 服务器。</span>",
    lead: "Mingle 是运行在你本机的开源程序——没有 Mingle 后端、没有云端中转、没有账号体系、没有遥测。下面完整列出数据流向、凭据存储与防滥用权限机制。",
    metaNote: "仅监听 127.0.0.1 · 系统钥匙串 / DPAPI / Secret Service · 零遥测 · MIT 开源",
    factsEyebrow: "可核验的架构事实",
    factsTitle: "安全模型一览。",
    factsHeaders: ["维度", "Mingle 的实际做法"],
    factsRows: [
      ["Mingle 云端服务器", "不存在。没有 Mingle 服务端、没有中转节点、没有账号，也没有埋点或遥测。"],
      [
        "消息流转路径",
        "聊天软件官方接口 ↔ 你电脑上的 Mingle ↔ 本机 coding agent harness ↔ 你自己的模型提供商。中间不经过任何 Mingle 服务器。",
      ],
      [
        "公网端口 / 回调地址",
        "无需暴露任何端口。9 个网络渠道全部由本机主动出站连接（WebSocket / Stream / 长轮询 / ETag 轮询）；iMessage 读取本机 macOS「信息」数据库。",
      ],
      ["本地控制台与 API", "严格仅监听 127.0.0.1（默认端口 7419），绝不绑定到 0.0.0.0。"],
      [
        "机器人凭据存储",
        "所有 token 与密钥仅存入 macOS 钥匙串、Windows DPAPI 或 Linux Secret Service，绝不以明文落盘在配置文件中。",
      ],
      [
        "本机数据与记忆目录",
        "每个 Agent 主目录仅包含纯文本 Markdown：ROLE.md、MEMORY.md 与 notes/。其余状态和日志在 ~/.mingle（MINGLE_HOME）。",
      ],
      [
        "Owner 认领与公开平台审批",
        "扫码渠道由扫码者自动成为 owner；token 渠道需输入本地控制台显示的 6 位认领码。Telegram、Discord、QQ 等公开平台上的陌生人和新群默认等待 owner 审批通过后才响应。",
      ],
      [
        "GitHub 公开仓库防滥用",
        "校验每条评论的 author_association，仅响应仓库 OWNER、MEMBER 与 COLLABORATOR 的 @；公开仓库中外部陌生人的 @ 会被直接忽略。",
      ],
      [
        "紧急停止与代码可审计",
        "Owner 随时可在聊天里发 /stop 立即中断当前任务。完整源码以 MIT 协议开源在 GitHub，并开启私密安全漏洞通道。",
      ],
    ],
    pillarsEyebrow: "安全边界",
    pillarsTitle: "四层防护，守住本机数据与模型额度。",
    pillars: [
      [
        "无云端桥接，不暴露公网端口",
        "全渠道均通过官方 SDK 长连接、长轮询或 ETag 轮询由本机主动外连，无需开 ngrok、买 VPS 或暴露公网 webhook，也没有第三方云桥接能看到团队聊天。",
      ],
      [
        "操作系统级凭据托管",
        "Slack、Discord、Telegram、飞书、微信、企业微信、钉钉、QQ 与 GitHub 凭据统一交由 macOS 钥匙串、Windows DPAPI 或 Linux Secret Service 保管，不写明文 JSON/YAML。",
      ],
      [
        "公开机器人默认拒绝陌生人消耗额度",
        "Telegram、Discord、QQ 上任何未获批准的新用户和新群都不会唤醒你的 Claude Code / Codex；GitHub 只认仓库协作者；iMessage 仅限你自己的自聊窗口。",
      ],
      [
        "透明可控的纯文本记忆",
        "Agent 的角色与长期记忆全部以普通 Markdown（ROLE.md、MEMORY.md、notes/）存在你指定的本机目录里，随时可查、可改、可备份、可删除。",
      ],
    ],
    faq: [
      [
        "我的聊天消息、文件或代码会经过 Mingle 的服务器吗？",
        "不会。Mingle 根本没有服务器。消息只在你使用的聊天软件（如飞书、Slack）、运行 Mingle 的本机电脑，以及你本地 coding agent 所连的模型提供商之间流转。",
      ],
      [
        "机器人 token 存在电脑的哪里？",
        "只保存在系统级凭据存储里：macOS 存钥匙串（Keychain），Windows 用 DPAPI 加密，Linux 存 Secret Service。",
      ],
      [
        "怎么防止别人在公开机器人上乱花我的 Claude Code / Codex 额度？",
        "Owner 只能通过扫码或读取本地 127.0.0.1 控制台的 6 位认领码确认；Telegram、Discord、QQ 上陌生人或新群发消息必须先经你审批；GitHub 只响应仓库 OWNER、MEMBER 和 COLLABORATOR。",
      ],
      [
        "桌面端是否签名？发现安全漏洞怎么反馈？",
        "macOS 版已经过 Apple 签名与公证，各平台最新签名说明请以对应版本的 GitHub Release Notes 为准。如发现安全问题，请通过 earayu/Mingle 的 GitHub Security Advisories 私下提交。",
      ],
    ],
  },
};

export const comparePage = {
  en: {
    path: "/compare/",
    title: "Compare Mingle vs. Cloud Agent Platforms & Self-Hosted Bridges · Mingle",
    description:
      "Objective comparison of Mingle (local-first, zero server) vs. cloud-hosted agent platforms, self-hosted VPS webhook bridges, and terminal-only coding agents—plus the full 10-channel capability matrix.",
    eyebrow: "Compare & Capabilities",
    h1: "How Mingle compares.<br><span>Clear facts, no hype.</span>",
    lead: "Choosing how to put Claude Code, Codex, OpenCode or Kimi Code into your chat apps comes down to where the runtime lives, how you pay for models, and whether you want to maintain a server.",
    metaNote: "Local-first vs. Cloud vs. VPS Bridge · Full 10-platform capability matrix",
    tableEyebrow: "Architecture comparison",
    tableTitle: "Mingle vs. common alternatives.",
    tableHeaders: [
      "Dimension",
      "Mingle (local-first)",
      "Cloud agent platforms",
      "Self-hosted VPS webhook bridge",
      "Terminal-only coding agent",
    ],
    tableRows: [
      ["Server / VPS required", "No (runs on your Mac/PC/Linux)", "Vendor cloud", "Yes (VPS + HTTPS domain)", "No"],
      ["Public URL / ngrok needed", "No (outbound official APIs)", "Managed by vendor", "Usually yes", "N/A"],
      [
        "Model billing",
        "Reuse your existing harness subscription or API key ($0 markup)",
        "Platform subscription or per-token markup",
        "Usually API key only",
        "Your harness subscription or API key",
      ],
      [
        "Chat data & memory residency",
        "Your disk (ROLE.md, MEMORY.md, notes/)",
        "Vendor database",
        "Your VPS",
        "Your disk (no chat integration)",
      ],
      [
        "Credential storage",
        "OS Keychain / DPAPI / Secret Service",
        "Vendor cloud vault",
        "Usually .env / config file on VPS",
        "Local harness auth",
      ],
      [
        "Cross-app shared memory",
        "Yes — 1 agent across all 10 platforms",
        "Varies (often per workspace/bot)",
        "Usually 1 bot per app",
        "No chat apps",
      ],
      [
        "Supported coding harnesses",
        "14 via OAR (Claude Code, Codex, OpenCode, Kimi Code verified E2E)",
        "Usually locked to 1 provider",
        "Usually 1 specific CLI/API",
        "1 per CLI",
      ],
      [
        "Local repo & file access",
        "Direct access on your machine",
        "Requires cloud sync / sandbox",
        "Only what is cloned on VPS",
        "Direct access",
      ],
    ],
    matrixHeaders: ["Platform", "Transport (no server)", "Setup", "Chats", "Threads / Live", "Files", "Access control"],
    matrixRows: [
      [
        "slack",
        "Socket Mode WebSocket",
        "Pre-filled manifest + tokens",
        "DMs & channels",
        "Thread replies, reactions",
        "In & out",
        "6-digit owner claim",
      ],
      [
        "discord",
        "Gateway WebSocket",
        "Bot token + intent",
        "DMs & servers",
        "Native threads, reactions, typing",
        "In & out",
        "Owner approval gate",
      ],
      [
        "telegram",
        "Bot API long polling",
        "BotFather token",
        "DMs & groups",
        "Quote replies, reactions, typing",
        "In & out",
        "Owner approval gate",
      ],
      [
        "imessage",
        "Local macOS Messages",
        "Local Apple ID (Mac)",
        "Self-chat only",
        "Standard messages",
        "In & out",
        "Own Apple ID only",
      ],
      [
        "feishu",
        "Official SDK long conn",
        "QR scan (verified real tenant)",
        "DMs, groups & Docs",
        "Native threads, live cards, reactions",
        "In & out",
        "QR owner binding",
      ],
      [
        "wechat",
        "Official Bot long polling",
        "QR scan",
        "Direct messages",
        "Typing indicator",
        "In & out",
        "QR owner binding",
      ],
      [
        "wecom",
        "Official AI Bot WebSocket",
        "QR scan",
        "DMs & groups",
        "Streaming replies, quotes",
        "In & out",
        "QR owner binding",
      ],
      [
        "dingtalk",
        "Official Stream WebSocket",
        "QR device registration",
        "DMs & groups",
        "AI live cards, reactions",
        "In & out (20 MB)",
        "QR owner binding",
      ],
      [
        "qq",
        "Official QQ Bot WebSocket",
        "QR scan / AppID",
        "DMs & groups (@)",
        "Typing notice (DM)",
        "In & out",
        "Owner approval gate",
      ],
      [
        "github",
        "REST Notifications (ETag)",
        "Device code / PAT",
        "Issues, PRs & reviews",
        "Inline PR review threads, reactions",
        "No",
        "Repo OWNER / MEMBER / COLLABORATOR",
      ],
    ],
    fitEyebrow: "Decision guide",
    fitTitle: "When Mingle fits—and when another setup fits better.",
    fitPoints: [
      [
        "Pick Mingle when you want zero-server convenience & existing subscriptions",
        "You already pay for Claude Code, Codex, OpenCode or Kimi Code, want to reach your local machine from Slack, WeChat, Feishu, Telegram, Discord, GitHub or iMessage, and do not want to rent a VPS or trust a cloud relay.",
      ],
      [
        "Pick Mingle when you want one companion across multiple apps",
        "You work across several chat apps (for example Feishu or Slack at work, WeChat or iMessage on mobile, and GitHub for PRs) and want one agent with one continuous memory across all of them.",
      ],
      [
        "Pick a hosted cloud platform when your machine is never online",
        "Because Mingle runs strictly on your own computer, the agent is online while that computer is awake. If you need 24/7 availability with zero personal hardware running, a hosted service or an always-on home mini-PC/Mac mini running Mingle is a better fit.",
      ],
      [
        "Pick an enterprise SaaS when you need multi-tenant org SSO & centralized billing",
        "Mingle is intentionally single-owner / local-first with no Mingle account or cloud control plane. Large organizations that need central seat management and vendor-hosted audit logs should use an enterprise SaaS.",
      ],
    ],
    faq: [
      [
        "How does Mingle avoid needing ngrok or a VPS when other bot bridges require one?",
        "Mingle only uses outbound-initiated official transports: Slack Socket Mode, Discord Gateway, Telegram long polling, Feishu/WeCom/DingTalk/QQ official WebSocket SDKs, WeChat bot long polling, GitHub ETag polling, and local macOS Messages.",
      ],
      [
        "Can I run Mingle on an always-on Mac mini or home Linux box?",
        "Yes. Mingle ships desktop installers and CLI installs for macOS, Windows and Linux, runs cleanly in the background, and exposes its console on 127.0.0.1.",
      ],
      [
        "Does Mingle lock me into one AI provider or one chat app?",
        "No. Mingle drives 14 coding harnesses through OAR and connects 10 chat/developer platforms, while keeping your agent's role and memory in plain local Markdown files.",
      ],
    ],
  },
  zh: {
    path: "/zh/compare/",
    title: "方案对比与 10 渠道能力矩阵：Mingle vs 云端托管与自建桥接 · Mingle",
    description:
      "客观对比 Mingle（本机零服务器）与云端 Agent 平台、自建 VPS Webhook 桥接及纯终端 coding agent 的差异，并附 10 个聊天平台完整协议与能力矩阵。",
    eyebrow: "方案对比与能力矩阵",
    h1: "Mingle 和其他方案有什么区别？<br><span>客观事实，一表看清。</span>",
    lead: "要把 Claude Code、Codex、OpenCode 或 Kimi Code 接进聊天软件，核心取舍无非三点：程序跑在哪、模型怎么计费、要不要自己维护服务器。",
    metaNote: "本地零服务器 vs 云端托管 vs VPS 桥接 · 10 平台完整能力矩阵",
    tableEyebrow: "架构对比",
    tableTitle: "Mingle 与常见方案对比。",
    tableHeaders: [
      "对比维度",
      "Mingle（本机零服务器）",
      "云端 Agent 托管平台",
      "自建 VPS Webhook 桥接",
      "纯终端 Coding Agent",
    ],
    tableRows: [
      ["是否需要服务器 / VPS", "不需要（直接跑在你电脑上）", "厂商云端", "需要（VPS + HTTPS 域名）", "不需要"],
      ["是否需要公网 URL / ngrok", "不需要（纯出站官方接口）", "厂商托管", "通常需要", "不涉及"],
      [
        "模型计费方式",
        "直接复用已有 harness 订阅或 API key（0 差价）",
        "平台会员或 token 加价",
        "通常只能用 API key",
        "复用已有订阅或 API key",
      ],
      [
        "聊天数据与记忆存储",
        "留在你本机（ROLE.md / MEMORY.md / notes/）",
        "厂商云端数据库",
        "你的 VPS 上",
        "留在你本机（无聊天接入）",
      ],
      [
        "机器人密钥存储",
        "系统钥匙串 / DPAPI / Secret Service",
        "厂商云端密钥库",
        "通常是 VPS 明文 .env / 配置",
        "本机 harness 登录态",
      ],
      [
        "跨聊天软件共享记忆",
        "支持 — 1 个 Agent 跨 10 平台共用",
        "视平台而定（常按机器人隔离）",
        "通常一软件一机器人",
        "无聊天软件接入",
      ],
      [
        "支持的 Coding Harness",
        "通过 OAR 支持 14 款（Claude Code / Codex / OpenCode / Kimi Code 端到端验证）",
        "通常绑定单一厂商模型",
        "通常只适配单一 CLI 或 API",
        "各自独立 CLI",
      ],
      ["访问本机代码与文件", "直接读写本机仓库和工具", "需云端同步或沙箱", "仅限 VPS 上克隆的副本", "直接读写本机"],
    ],
    matrixHeaders: ["平台", "连接协议（无服务器）", "接入方式", "支持场景", "话题 / 实时进度", "文件收发", "权限控制"],
    matrixRows: [
      [
        "slack",
        "官方 Socket Mode WebSocket",
        "预填 Manifest + token",
        "私聊与频道",
        "线索回复、表情回应",
        "双向收发",
        "6 位 owner 认领码",
      ],
      [
        "discord",
        "官方 Gateway WebSocket",
        "Bot Token + Intent",
        "私聊与服务器",
        "原生话题、表情、输入中",
        "双向收发",
        "陌生人需 owner 审批",
      ],
      [
        "telegram",
        "官方 Bot API 长轮询",
        "BotFather Token",
        "私聊与群组",
        "引用回复、表情、输入中",
        "双向收发",
        "陌生人需 owner 审批",
      ],
      [
        "imessage",
        "本机 macOS「信息」App",
        "本机 Apple ID（仅 Mac）",
        "仅自聊窗口",
        "普通消息",
        "双向收发",
        "仅限本人 Apple ID",
      ],
      [
        "feishu",
        "官方 SDK 长连接",
        "手机扫码（真实租户已验证）",
        "私聊、群聊与云文档评论",
        "原生话题、流式卡片、表情",
        "双向收发",
        "扫码人成为 owner",
      ],
      ["wechat", "官方机器人长轮询", "手机微信扫码", "1 对 1 私聊", "正在输入提示", "双向收发", "扫码人成为 owner"],
      [
        "wecom",
        "官方智能机器人 WebSocket",
        "企业微信扫码",
        "私聊与群聊",
        "流式回复、引用回复",
        "双向收发",
        "扫码人成为 owner",
      ],
      [
        "dingtalk",
        "官方 Stream WebSocket",
        "钉钉扫码设备注册",
        "私聊与群聊",
        "AI 流式卡片、表情回应",
        "双向（最高 20 MB）",
        "扫码人成为 owner",
      ],
      [
        "qq",
        "腾讯官方 QQ Bot WebSocket",
        "QQ 扫码 / AppID",
        "私聊与群聊（@）",
        "单聊输入提示",
        "双向收发",
        "陌生人需 owner 审批",
      ],
      [
        "github",
        "REST 通知 API（ETag 轮询）",
        "验证码 / PAT",
        "Issue、PR 与行内 Review",
        "行内 Review 线程、表情",
        "不支持",
        "仅仓库 OWNER / MEMBER / COLLABORATOR",
      ],
    ],
    fitEyebrow: "选型建议",
    fitTitle: "什么时候适合用 Mingle，什么时候不适合？",
    fitPoints: [
      [
        "想零服务器复用已有订阅：选 Mingle",
        "你已经买了 Claude Code、Codex、OpenCode 或 Kimi Code，想直接在微信、飞书、Slack、Telegram、Discord、GitHub 或 iMessage 里调用本机 Agent，不想折腾 VPS 也不想把公司聊天交给第三方云中转。",
      ],
      [
        "想让同一个 Agent 跨多个聊天软件记住所有上下文：选 Mingle",
        "日常同时用飞书/钉钉/Slack 办公、微信/iMessage 沟通、GitHub 审代码，希望同一个 Agent 记住所有平台发生的事，而不是到处重复背景。",
      ],
      [
        "电脑平时完全关机、且需要 7×24 云端在线：更适合云端托管或常开小主机",
        "因为 Mingle 严格跑在你自己的电脑上，电脑合盖休眠时 Agent 会离线。如果需要 24 小时待命，可以在一台常开的 Mac mini / 家庭 Linux 主机上跑 Mingle，或选择云端托管方案。",
      ],
      [
        "大团队需要统一 SSO 账号与中心化计费审计：更适合企业级 SaaS",
        "Mingle 刻意保持单机归属、无账号、无云控台的设计。如果你的组织需要中心化席位管理和厂商托管合规审计日志，企业级 SaaS 会更合适。",
      ],
    ],
    faq: [
      [
        "为什么别的机器人桥接常要配 ngrok 或 VPS，而 Mingle 不需要？",
        "因为 Mingle 全部选用本机主动出站的官方通道：Slack Socket Mode、Discord Gateway、Telegram 长轮询、飞书/企微/钉钉/QQ 官方 WebSocket SDK、微信官方长轮询、GitHub ETag 轮询，以及 Mac 本机 iMessage。",
      ],
      [
        "可以把 Mingle 装在常开的 Mac mini 或家里 Linux 主机上 24 小时跑吗？",
        "完全可以。Mingle 提供 macOS、Windows 和 Linux 桌面端与 CLI 安装包，支持后台常驻运行，控制台仅监听 127.0.0.1。",
      ],
      [
        "用 Mingle 会被绑定在某一家大模型或某一个聊天软件上吗？",
        "不会。Mingle 通过 OAR 驱动 14 款 coding harness，同时连接 10 个聊天/开发平台，且 Agent 的记忆全部以本地纯文本 Markdown 保存，随时可迁移。",
      ],
    ],
  },
};
