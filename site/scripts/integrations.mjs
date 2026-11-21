// Bilingual integration landing pages for mingle.build (/<app>/ and /zh/<app>/).
// Keep English and Chinese in step, and keep every claim grounded in src/channels/.

export const integrationOrder = ["slack", "discord", "telegram", "imessage", "feishu", "wechat"];

export const integrationsUi = {
  en: {
    backHome: "All chat apps",
    breadcrumbHome: "Mingle",
    howEyebrow: "How it connects",
    howTitle: "Zero cloud server. Minutes to set up.",
    howImgAlt: "Connect a chat app in the Mingle console: official bot channels and local setup checks",
    worksEyebrow: "What works",
    faqEyebrow: "Questions",
    faqTitle: "Common questions.",
    moreEyebrow: "More chat apps",
    moreTitle: "One agent, every chat app.",
    moreLead:
      "The same local agent keeps one long-lived memory across every chat app you connect—ask in one app about what happened in another.",
    seeAll: "See full overview",
  },
  zh: {
    backHome: "全部聊天软件",
    breadcrumbHome: "Mingle",
    howEyebrow: "连接方式",
    howTitle: "没有服务器，几分钟接好。",
    howImgAlt: "在 Mingle 控制台连接聊天软件：官方机器人通道与本机配置检查",
    worksEyebrow: "支持的能力",
    faqEyebrow: "常见问题",
    faqTitle: "常见疑问。",
    moreEyebrow: "更多聊天软件",
    moreTitle: "同一个 Agent，住进更多聊天软件。",
    moreLead: "同一个本机 Agent 共用一份记忆，同时接入多个聊天软件——在一个软件里也能直接问另一个软件里发生的事。",
    seeAll: "查看完整介绍",
  },
};

export const integrations = {
  en: {
    slack: {
      title: "Connect Claude Code & Codex to Slack Locally · Mingle",
      description:
        "Bring Claude Code, Codex, OpenCode and 14 local coding agents into Slack over Socket Mode. No cloud server, no webhook, no ngrok—credentials stay in your OS keychain.",
      eyebrow: "Mingle for Slack",
      h1: "Claude Code & Codex in Slack.<br><span>No cloud server.</span>",
      lead: "Connect the coding agent on your own computer to your Slack workspace over official Socket Mode. No public URL, no third-party relay, and no extra model bill.",
      transportNote: "Slack Socket Mode · No webhook or ngrok · Keychain credentials",
      steps: [
        [
          "Create the Slack app from a pre-filled manifest",
          "Pick Slack in the Mingle console and open the pre-filled Slack App Manifest link. Permissions, Socket Mode and bot events are already configured for your agent.",
        ],
        [
          "Paste the Bot Token and App-Level Token",
          "Mingle verifies both tokens locally, stores them only in the macOS Keychain, Windows DPAPI or Linux Secret Service, and opens an outbound WebSocket to Slack.",
        ],
        [
          "Invite your agent to channels or DM it",
          "Mention @Alex in any channel or send a direct message. Claim ownership with the 6-digit code in the console, and your local Claude Code or Codex session starts replying right in Slack.",
        ],
      ],
      worksTitle: "Built for how teams use Slack.",
      highlights: [
        [
          "Socket Mode, zero public server",
          "Mingle initiates an outbound WebSocket to Slack from your computer. There is no webhook endpoint to host, no reverse proxy, and no Mingle cloud relay.",
        ],
        [
          "Threads, reactions and live replies",
          "Your agent acknowledges messages with a reaction, works on longer tasks on the side, and replies back under the original Slack thread without blocking quick questions.",
        ],
        [
          "Files in and out",
          "Send logs, screenshots or specs in Slack and let your local coding agent read them on disk—or send generated files and diffs back into the channel.",
        ],
        [
          "One shared memory across apps",
          "The same agent in Slack can also live in Discord, Telegram, Feishu, WeChat or GitHub with one local memory (ROLE.md, MEMORY.md and notes/).",
        ],
      ],
      faq: [
        [
          "Do I need a public URL, webhook or ngrok to connect Slack?",
          "No. Mingle uses Slack Socket Mode, so your machine opens an outbound WebSocket directly to Slack. No public server or tunnel is required.",
        ],
        [
          "Where are my Slack tokens and chat history stored?",
          "Your Bot Token and App-Level Token are stored only in your operating system keychain (macOS Keychain, Windows DPAPI or Linux Secret Service). Agent memory and local logs stay on your own disk.",
        ],
        [
          "Can I use my existing Claude Code or Codex subscription in Slack?",
          "Yes. Mingle drives whichever local harness you already have signed in—Claude Code, Codex, OpenCode, Kimi Code and 10 more via OAR—without adding a model markup.",
        ],
      ],
    },
    discord: {
      title: "Connect Claude Code & Codex to Discord Locally · Mingle",
      description:
        "Run Claude Code, Codex or OpenCode as a Discord bot straight from your computer over the Discord Gateway. Native threads, owner approval, and zero cloud server.",
      eyebrow: "Mingle for Discord",
      h1: "Claude Code & Codex in Discord.<br><span>No cloud server.</span>",
      lead: "Bring your local coding agent into Discord servers and direct messages over the official Discord Gateway. Native threads, owner approval for strangers, and zero relay server.",
      transportNote: "Discord Gateway WebSocket · Native threads · Owner approval",
      steps: [
        [
          "Create a bot in the Discord Developer Portal",
          "Create an application, enable Message Content Intent, and invite the bot to your server with channel and thread permissions.",
        ],
        [
          "Paste the bot token into Mingle",
          "Mingle stores the token in your OS keychain and connects outbound to the Discord Gateway WebSocket—no hosting, no webhook, no public IP.",
        ],
        [
          "Claim ownership and approve who can talk to it",
          "Send the 6-digit claim code to become the owner. Because anyone can find a Discord bot, new people and servers wait for your approval before your agent acts for them.",
        ],
      ],
      worksTitle: "Made for Discord servers and DMs.",
      highlights: [
        [
          "Native Discord threads for long jobs",
          "Hand your agent a longer coding or research task and it opens a thread under your message for progress and follow-ups, while keeping the main channel responsive.",
        ],
        [
          "Owner approval on a public platform",
          "New users and new servers cannot run your local agent until you explicitly approve them in the Mingle console.",
        ],
        [
          "Typing indicators, reactions and files",
          "Full support for quote replies, emoji reactions, typing indicators, @-mentions, and two-way file uploads and downloads.",
        ],
        [
          "Same agent across Discord and other chats",
          "Ask your agent in Discord about a note from Slack, Telegram or GitHub—every channel shares one local session and plain-text Markdown memory.",
        ],
      ],
      faq: [
        [
          "Can strangers on Discord use my local coding agent?",
          "No. On public apps like Discord, Telegram and QQ, every new person or server waits for your explicit approval before the agent responds or runs tasks for them.",
        ],
        [
          "Does Mingle require hosting a Discord bot on a VPS?",
          "No. Mingle runs on your own macOS, Windows or Linux machine and connects outbound over the Discord Gateway. If you want 24/7 uptime, you can also run it on your own machine or SSH host.",
        ],
        [
          "Does the Discord bot support threads and file attachments?",
          "Yes. Mingle supports native Discord public threads for parallel tasks, quoted replies, reactions, typing indicators, and sending or receiving files.",
        ],
      ],
    },
    telegram: {
      title: "Connect Claude Code & Codex to Telegram Locally · Mingle",
      description:
        "Connect Claude Code, Codex, OpenCode and Kimi Code to Telegram using BotFather and local long polling. No webhook, no cloud relay, with owner approval built in.",
      eyebrow: "Mingle for Telegram",
      h1: "Claude Code & Codex in Telegram.<br><span>No cloud server.</span>",
      lead: "Turn a standard BotFather bot into your local coding agent in Telegram DMs and groups. Runs on your computer with outbound long polling—no webhook and no Mingle server.",
      transportNote: "Telegram Bot API long polling · No webhook · CLI & desktop setup",
      steps: [
        [
          "Create a bot with @BotFather",
          "Open @BotFather in Telegram, run /newbot, and copy the bot token. If you want the agent to follow group context without @-mentions every time, disable privacy mode in BotFather.",
        ],
        [
          "Connect the token in the console or CLI",
          'Paste the token in the Mingle console, or run echo "$TELEGRAM_BOT_TOKEN" | mingle connect alex telegram. Mingle saves it to your OS keychain and starts long polling.',
        ],
        [
          "Message your bot to claim ownership",
          "Send your bot the 6-digit claim code (or first DM). After that, any new person or group that finds your bot waits for your OK before the agent works for them.",
        ],
      ],
      worksTitle: "Fast on mobile, private on your machine.",
      highlights: [
        [
          "Long polling, zero webhook setup",
          "Mingle polls the official Telegram Bot API directly from your computer. No domain, no TLS certificate, no reverse proxy, and no hosted bridge.",
        ],
        [
          "Strangers wait for your approval",
          "Telegram bot usernames are public, so Mingle holds requests from unfamiliar people or groups until you approve them as the owner.",
        ],
        [
          "Reactions, quote replies and files",
          "Your agent reacts while working, quotes the exact message it is answering, shows typing status, and exchanges files directly in Telegram.",
        ],
        [
          "Scriptable from the terminal",
          "Create an agent and bind Telegram in two shell commands, or manage everything from the local web console on 127.0.0.1.",
        ],
      ],
      faq: [
        [
          "Do I need a webhook URL to connect a Telegram bot to Claude Code?",
          "No. Mingle uses Telegram Bot API long polling over outbound HTTPS, so it works behind home Wi-Fi, NAT or a firewall with zero server setup.",
        ],
        [
          "Can I add my Mingle Telegram bot to group chats?",
          "Yes. Add the bot to any Telegram group and approve the group as owner. You can @-mention the agent or call it by name, and it handles multiple tasks in parallel without blocking the room.",
        ],
        [
          "Is my Telegram bot token stored in plain text?",
          "No. Mingle stores bot tokens in the macOS Keychain, Windows DPAPI or Linux Secret Service—never in the SQLite database, logs or API responses.",
        ],
      ],
    },
    imessage: {
      title: "Use Claude Code & Codex in iMessage on Mac · Mingle",
      description:
        "Talk to your local Claude Code or Codex agent in iMessage on macOS using your own Apple ID self-chat. No cloud bridge, no third-party server, works from iPhone and Mac.",
      eyebrow: "Mingle for iMessage",
      h1: "Claude Code & Codex in iMessage.<br><span>Local on your Mac.</span>",
      lead: "Text yourself in Apple Messages from your iPhone, iPad or Mac and get answers from the coding agent running on your Mac. Uses your own Apple ID locally—zero cloud bridge.",
      transportNote: "macOS only · Local Messages.app · Your own Apple ID",
      steps: [
        [
          "Choose iMessage in Mingle on your Mac",
          "Open your agent in the Mingle desktop app on macOS and select iMessage. Mingle detects the iMessage accounts already signed in to Apple Messages.",
        ],
        [
          "Grant two standard macOS permissions",
          "Allow Full Disk Access so Mingle can read ~/Library/Messages/chat.db read-only, and allow Automation so Mingle can send replies through Messages.app.",
        ],
        [
          "Text yourself from iPhone, iPad or Mac",
          "Open your chat with yourself in Messages and ask anything. Because iCloud syncs your self-chat across Apple devices, you can reach your local coding agent from your phone anywhere.",
        ],
      ],
      worksTitle: "Private self-chat, zero cloud bridge.",
      highlights: [
        [
          "No unofficial cloud relay",
          "iMessage has no official bot API, so Mingle never asks for your Apple ID password or routes messages through a third-party bridge. Everything runs locally on your Mac.",
        ],
        [
          "Reach your Mac from iPhone or iPad",
          "Text your own Apple ID from your pocket and let Claude Code or Codex on your Mac run tasks, check files, set reminders and reply right back in Messages.",
        ],
        [
          "Self-chat only, no accidental group spam",
          "Mingle listens only to your conversation with yourself on your own Apple ID, keeping personal iMessage threads with friends and family completely untouched.",
        ],
        [
          "Shared memory with your work chat apps",
          "Ask in iMessage what your agent summarized in Slack, Feishu or Discord earlier—it is the same agent with the same ROLE.md and MEMORY.md on your Mac.",
        ],
      ],
      faq: [
        [
          "Does Mingle need my Apple ID password?",
          "Never. Mingle works through the Apple Messages app already signed in on your Mac, reading the local Messages database read-only and sending via macOS Automation.",
        ],
        [
          "Can I use iMessage with Mingle from my iPhone?",
          "Yes. As long as Mingle is running on your Mac and iMessage is synced with your Apple ID, texting yourself from your iPhone or iPad reaches your local agent on the Mac.",
        ],
        [
          "Does Mingle message other contacts in my iMessage?",
          "No. Mingle only operates in your self-chat on your own Apple ID, never sending unsolicited messages to other people in your Messages app.",
        ],
      ],
    },
    feishu: {
      title: "Connect Claude Code & Codex to Feishu & Lark Locally · Mingle",
      description:
        "Connect Claude Code, Codex, OpenCode and Kimi Code to Feishu or Lark with a QR scan and official persistent long connection. Native threads, live cards, and zero cloud server.",
      eyebrow: "Mingle for Feishu / Lark",
      h1: "Claude Code & Codex in Feishu.<br><span>QR scan, no server.</span>",
      lead: "Scan a QR code with Feishu or Lark to connect your local coding agent over the official SDK long connection. Native threads, live streaming cards, document comments, and no public callback URL.",
      transportNote: "Official Feishu/Lark SDK · QR onboarding & long connection · Verified on live tenant",
      steps: [
        [
          "Scan the QR code in Mingle",
          "Click Connect Feishu in the Mingle console and scan the QR code with Feishu or Lark on your phone. Official QR app registration sets up the bot without manual webhook wiring.",
        ],
        [
          "Persistent long connection from your machine",
          "Mingle stores the app credentials in your OS keychain and opens an official Feishu persistent connection straight from your computer—no public server or callback URL needed.",
        ],
        [
          "Chat in DMs, groups, threads and docs",
          "Whoever scans the QR code automatically becomes the agent's owner. Mention your agent in group chats, follow progress in live cards and native threads, or @ it in Feishu document comments.",
        ],
      ],
      worksTitle: "Battle-tested on a live Feishu tenant.",
      highlights: [
        [
          "Official QR scan & long connection",
          "No server to deploy, no public callback URL to expose, and no cloud relay sitting between your Feishu workspace and your local coding agent.",
        ],
        [
          "Live streaming cards & native threads",
          "Long tasks spin off into native Feishu reply threads with live progress cards while the agent keeps answering quick questions in the main group.",
        ],
        [
          "Feishu document comments & files",
          "Respond to comment threads inside Feishu docs, list group members, and send or receive files directly through the official Feishu API.",
        ],
        [
          "Cross-app memory with WeChat, Slack & GitHub",
          "Your agent remembers decisions from Feishu groups when you later message it in WeChat, Telegram, Slack or GitHub.",
        ],
      ],
      faq: [
        [
          "Do I need a public server or callback URL for Feishu?",
          "No. Mingle uses the official Feishu/Lark SDK persistent long connection, so your computer receives events directly without exposing an HTTP endpoint.",
        ],
        [
          "Does Mingle support both Feishu and international Lark?",
          "Yes. The connector uses the official Feishu/Lark SDK with QR registration and long connection.",
        ],
        [
          "How does owner permission work when I scan the QR code?",
          "Whoever completes the QR scan becomes the agent's owner automatically. Credentials are saved only in your OS keychain, and Mingle runs locally on 127.0.0.1.",
        ],
      ],
    },
    wechat: {
      title: "Connect Claude Code & Codex to WeChat Locally · Mingle",
      description:
        "Connect Claude Code, Codex, OpenCode and Kimi Code to WeChat by scanning a QR code on your phone. Official bot channel with local long polling, file transfer, and zero cloud server.",
      eyebrow: "Mingle for WeChat",
      h1: "Claude Code & Codex in WeChat.<br><span>QR scan, no server.</span>",
      lead: "Scan a QR code in Mingle to chat directly with your local coding agent in WeChat. Uses the official bot channel with local long polling—no cloud relay, no extra account, and one shared memory.",
      transportNote: "Official WeChat bot QR scan · Local long polling · Direct messages & files",
      steps: [
        [
          "Click Connect WeChat in Mingle",
          "Open your agent in the Mingle desktop app or local console and pick WeChat to generate an official login QR code.",
        ],
        [
          "Scan with WeChat on your phone",
          "Confirm on your phone. Mingle stores the bot token in your OS keychain and long-polls directly from your computer with zero middleman server.",
        ],
        [
          "Message your agent directly in WeChat",
          "Whoever scanned the QR code becomes the owner. Send text or files in WeChat—and ask your agent about work from Feishu, Slack, Discord or GitHub thanks to its shared local memory.",
        ],
      ],
      worksTitle: "Your local coding agent, right in WeChat.",
      highlights: [
        [
          "Official bot channel, zero cloud relay",
          "Mingle connects straight from your computer over long polling—no third-party cloud bridge and no Mingle backend seeing your WeChat messages.",
        ],
        [
          "One-minute QR setup",
          "Scan once in WeChat to bind the bot and claim ownership automatically. Credentials stay inside the macOS Keychain, Windows DPAPI or Linux Secret Service.",
        ],
        [
          "Typing status and two-way file transfer",
          "See when your agent is working and exchange documents, images or generated files directly in your WeChat chat.",
        ],
        [
          "Ask in WeChat about Feishu, Slack or GitHub",
          "Because one agent shares one ROLE.md and MEMORY.md across every platform, you can check on work discussions from other apps right inside WeChat.",
        ],
      ],
      faq: [
        [
          "Does Mingle send my WeChat messages through a Mingle server?",
          "No. Mingle has no server, no account and no telemetry. It runs on your own machine and long-polls the official bot interface directly.",
        ],
        [
          "Does WeChat support direct messages or group chats?",
          "The official WeChat bot channel connects direct 1-on-1 messages with your agent, including typing indicators and file uploads/downloads. For team group chats, connect the same agent to Feishu, WeCom, DingTalk, Slack, Discord or Telegram—all sharing one memory.",
        ],
        [
          "Do I need to pay extra to use Claude Code or Codex in WeChat?",
          "No. Mingle is free and MIT open source. It drives the coding agent harness and subscription (or API key) you already use locally.",
        ],
      ],
    },
  },
  zh: {
    slack: {
      title: "在 Slack 中本地接入 Claude Code 与 Codex · Mingle",
      description:
        "通过官方 Socket Mode 将本机的 Claude Code、Codex、OpenCode 等 14 款 coding agent 接入 Slack。无云端服务器、无需公网 webhook 或 ngrok，凭据仅存系统钥匙串。",
      eyebrow: "Mingle · Slack",
      h1: "在 Slack 里用 Claude Code 和 Codex，<br><span>不需要云服务器。</span>",
      lead: "通过 Slack 官方 Socket Mode，把运行在你电脑上的 coding agent 直接接入 Slack 工作区。不用配公网地址、不经过第三方中转，也不额外收模型费。",
      transportNote: "Slack Socket Mode 长连接 · 无需 webhook 或内网穿透 · 钥匙串保存凭据",
      steps: [
        [
          "用预填好的 Manifest 创建 Slack 应用",
          "在 Mingle 控制台选择 Slack，点开预填好的 Slack App Manifest 链接，所需权限、Socket Mode 和事件订阅都已经配好。",
        ],
        [
          "粘贴 Bot Token 与 App-Level Token",
          "Mingle 在本机校验 token，只存入 macOS 钥匙串、Windows DPAPI 或 Linux Secret Service，然后主动建立到 Slack 的 WebSocket 长连接。",
        ],
        [
          "把 Agent 拉进频道或直接私聊",
          "发一次控制台里的 6 位认领码确认 owner，之后在频道里 @ 它或私聊它，本机的 Claude Code 或 Codex 就会直接在 Slack 里回复。",
        ],
      ],
      worksTitle: "顺着团队在 Slack 里的习惯来。",
      highlights: [
        [
          "Socket Mode，零服务器部署",
          "由你本机的 Mingle 主动连向 Slack，不需要部署公网 webhook，不需要 ngrok 或反代，也没有 Mingle 中转服务器。",
        ],
        [
          "回复线索、表情回应与并行处理",
          "收到消息先回表情表示在看；遇到费时间的任务在旁边慢慢做，同时照样秒回频道里其他人的快问，做完回到原消息下回复。",
        ],
        [
          "双向收发文件",
          "在 Slack 里发日志、截图或文档，本机 Agent 可以直接读取分析，也能把生成的文件和结果发回频道。",
        ],
        [
          "跨聊天软件共享同一份记忆",
          "同一个 Agent 可以同时接入 Slack、飞书、微信、Discord、Telegram 和 GitHub，共用本机的 ROLE.md、MEMORY.md 和 notes/。",
        ],
      ],
      faq: [
        [
          "Slack 接入需要公网服务器、webhook 或 ngrok 吗？",
          "不需要。Mingle 使用 Slack 官方 Socket Mode，由你的电脑主动发起 WebSocket 连接，不需要暴露任何公网端口。",
        ],
        [
          "我的 Slack token 和聊天记忆存在哪里？",
          "Bot Token 和 App-Level Token 只保存在系统钥匙串（macOS 钥匙串、Windows DPAPI 或 Linux Secret Service）里，Agent 记忆和日志全部留在你自己的硬盘上。",
        ],
        [
          "可以直接用现有的 Claude Code 或 Codex 订阅吗？",
          "可以。Mingle 直接驱动你本机已登录的 Claude Code、Codex、OpenCode、Kimi Code 等 14 款 harness，不额外加模型费用。",
        ],
      ],
    },
    discord: {
      title: "在 Discord 中本地接入 Claude Code 与 Codex · Mingle",
      description:
        "通过 Discord 官方 Gateway 在本机把 Claude Code、Codex、OpenCode 接成 Discord 机器人。支持原生话题（Thread）、陌生人审批，无需部署云服务器。",
      eyebrow: "Mingle · Discord",
      h1: "在 Discord 里用 Claude Code 和 Codex，<br><span>不需要云服务器。</span>",
      lead: "通过 Discord 官方 Gateway，把本机 coding agent 接进你的 Discord 服务器和私聊。支持原生话题并行干活、陌生人审批，没有云端中转服务器。",
      transportNote: "Discord Gateway 长连接 · 原生 Thread 话题 · 陌生人需审批",
      steps: [
        [
          "在 Discord Developer Portal 创建机器人",
          "新建应用，打开 Message Content Intent，把机器人邀请进你的 Discord 服务器并授予频道与话题权限。",
        ],
        [
          "把 Bot Token 贴进 Mingle",
          "Mingle 将 token 存入系统钥匙串，直接从本机连向 Discord Gateway WebSocket，不用买 VPS，也不用配 webhook。",
        ],
        [
          "认领 owner 并按需审批新成员",
          "把 6 位认领码发给机器人成为 owner。因为任何人都可能找到公开的 Discord 机器人，新的人和新的服务器都要等你同意，Agent 才会替他们做事。",
        ],
      ],
      worksTitle: "原生适配 Discord 频道与话题。",
      highlights: [
        [
          "长任务自动开原生 Thread",
          "交给它写代码、查资料这类费时任务时，它会在你的消息下开一个 Discord Thread 记录进度和追问，不打断主频道聊天。",
        ],
        ["公开平台默认有陌生人审批", "没有经过你在控制台点同意的新用户或新服务器，无法调用你本机的 coding agent。"],
        ["输入状态、表情回应与文件收发", "支持引用回复、表情回应、正在输入提示、@ 提及，以及双向文件上传和下载。"],
        [
          "和飞书、Slack、微信共享同一份记忆",
          "在 Discord 里直接问它之前在 Slack、Telegram 或 GitHub 里讨论过的决定，所有渠道共用同一份纯文本 Markdown 记忆。",
        ],
      ],
      faq: [
        [
          "Discord 上的陌生人会随便消耗我的额度吗？",
          "不会。在 Discord、Telegram、QQ 这类谁都能找到机器人的平台上，新的人和新的服务器必须先经过你审批，Agent 才会响应。",
        ],
        [
          "需要自己租一台服务器托管 Discord 机器人吗？",
          "不需要。Mingle 直接运行在你自己的 macOS、Windows 或 Linux 电脑上，主动连向 Discord Gateway。",
        ],
        [
          "支持 Discord 的 Thread 话题和文件收发吗？",
          "支持。Mingle 支持在 Discord 频道里开原生公共话题并行处理长任务，也支持引用回复、表情回应、正在输入提示和文件收发。",
        ],
      ],
    },
    telegram: {
      title: "在 Telegram 中本地接入 Claude Code 与 Codex · Mingle",
      description:
        "用 BotFather 创建机器人，通过本机长轮询将 Claude Code、Codex、OpenCode 接入 Telegram。无需 webhook、无需云服务器，自带陌生人审批与命令行一键绑定。",
      eyebrow: "Mingle · Telegram",
      h1: "在 Telegram 里用 Claude Code 和 Codex，<br><span>不需要云服务器。</span>",
      lead: "把一个普通的 BotFather 机器人变成你本机的 coding agent，私聊和群聊都能用。通过本机长轮询直连官方接口，无需 webhook，也没有 Mingle 服务器。",
      transportNote: "Telegram 官方长轮询 · 无需 webhook · 支持控制台和命令行绑定",
      steps: [
        [
          "在 @BotFather 创建机器人",
          "在 Telegram 里找 @BotFather 执行 /newbot 拿到 bot token。如果希望 Agent 在群里不用每次都 @ 也能跟上上下文，在 BotFather 里关掉 Privacy Mode 即可。",
        ],
        [
          "在控制台或终端粘贴 Token",
          '在控制台里填入 token，或在终端执行 echo "$TELEGRAM_BOT_TOKEN" | mingle connect alex telegram。凭据只存系统钥匙串，本机自动开始长轮询。',
        ],
        [
          "私聊认领 owner，随时开聊",
          "给机器人发 6 位认领码（或首条私聊）成为 owner。之后新找到这个机器人的人或群，都要先等你审批才会生效。",
        ],
      ],
      worksTitle: "手机上随手聊，数据留在你电脑上。",
      highlights: [
        [
          "长轮询直连，零 webhook 配置",
          "Mingle 直接从你的电脑向 Telegram Bot API 发起出站 HTTPS 长轮询，不需要域名、不需要 HTTPS 证书，也不用配置反代。",
        ],
        [
          "新联系人和新群先问你",
          "Telegram 机器人用户名是公开的，因此陌生人或陌生群发来消息时，Mingle 会等你确认后再让 Agent 回复。",
        ],
        [
          "引用回复、表情回应与文件互传",
          "处理中显示表情回应与输入状态，回复时准确引用原消息，并支持直接收发文件与图片。",
        ],
        [
          "两条命令就能脚本化接好",
          "既可以在桌面应用和 127.0.0.1 本地控制台操作，也能用 mingle 命令行一键创建 Agent 并接入 Telegram。",
        ],
      ],
      faq: [
        [
          "Telegram 接入 Claude Code 需要公网 webhook 吗？",
          "不需要。Mingle 使用 Telegram Bot API 出站长轮询，在普通家庭 Wi-Fi 或公司内网里就能直接用，不需要部署任何服务器。",
        ],
        [
          "可以把 Telegram 机器人拉进群聊吗？",
          "可以。把机器人拉进群并在控制台审批后就能在群里 @ 它或喊名字触发，支持同时并行处理多件事，不阻塞群里聊天。",
        ],
        [
          "Telegram bot token 会明文存进数据库吗？",
          "不会。机器人 token 只保存在 macOS 钥匙串、Windows DPAPI 或 Linux Secret Service 里，不进 SQLite 数据库、不进日志、不出现在 API 响应里。",
        ],
      ],
    },
    imessage: {
      title: "在 Mac 的 iMessage 里本地用 Claude Code 与 Codex · Mingle",
      description:
        "在 macOS 上通过你自己的 Apple ID 自聊，把本机 Claude Code 和 Codex 接进 iMessage。不经过任何云端桥接，手机 iPhone 发消息就能驱动家里的 Mac。",
      eyebrow: "Mingle · iMessage",
      h1: "在 iMessage 里用 Claude Code 和 Codex，<br><span>只跑在你的 Mac 上。</span>",
      lead: "在 iPhone、iPad 或 Mac 的「信息」里给自己发消息，运行在 Mac 本机的 coding agent 就会在对话里直接回复你。用你自己的 Apple ID 在本机运行，不经过任何云端桥接。",
      transportNote: "仅限 macOS · 本机信息 App · 使用你自己的 Apple ID",
      steps: [
        [
          "在 Mac 上的 Mingle 里选择 iMessage",
          "在 macOS 桌面应用里打开 Agent 设置并选择 iMessage，Mingle 会自动读取本机「信息」App 里已登录的 Apple ID 账号。",
        ],
        [
          "授予两项标准 macOS 权限",
          "允许完全磁盘访问权限（仅以只读方式读取 ~/Library/Messages/chat.db），并允许自动化控制「信息」App 发送回复。",
        ],
        [
          "在 iPhone、iPad 或 Mac 上给自己发消息",
          "打开你和自己的对话发一句需求即可。借助 iCloud 信息同步，出门在外用 iPhone 也能随时叫你 Mac 上的 Claude Code 或 Codex 干活。",
        ],
      ],
      worksTitle: "私密自聊，不经任何云端桥接。",
      highlights: [
        [
          "没有第三方云端桥接",
          "iMessage 没有官方机器人接口，因此 Mingle 绝不索要你的 Apple ID 密码，也不用云端中转——完全通过你 Mac 本机的「信息」App 工作。",
        ],
        [
          "出门用 iPhone 驱动家里的 Mac",
          "在手机上给自己发条 iMessage，就能让 Mac 上的 Claude Code 或 Codex 查文件、跑任务、定提醒，并把结果直接发回对话里。",
        ],
        [
          "只监听自聊，绝不打扰别人",
          "Mingle 只读取和回复你与自己的对话，不会触碰你和家人、朋友、同事的其它 iMessage 聊天记录。",
        ],
        [
          "和飞书、微信、Slack 共用一份记忆",
          "在 iMessage 里可以直接问它今天在飞书群或 Slack 里记下的结论——背后是同一个本机 Agent 和同一份 MEMORY.md。",
        ],
      ],
      faq: [
        [
          "Mingle 需要我的 Apple ID 密码吗？",
          "完全不需要。Mingle 直接使用你 Mac 上已经登录好的苹果「信息」App，只读方式检查本地消息库，并通过 macOS 自动化发送回复。",
        ],
        [
          "在 iPhone 上也能用吗？",
          "可以。只要你的 Mac 上开着 Mingle 且开启了 iCloud 信息同步，你在 iPhone 或 iPad 上给自己发消息，Mac 上的 Agent 就会收到并回复到同一条对话里。",
        ],
        [
          "Mingle 会给我的其他联系人发消息吗？",
          "不会。Mingle 只在你自己 Apple ID 的自聊窗口里工作，不会给其他任何人发送消息。",
        ],
      ],
    },
    feishu: {
      title: "飞书本地接入 Claude Code 与 Codex（无服务器）· Mingle",
      description:
        "飞书手机扫码 1 分钟接入本机 Claude Code、Codex、OpenCode 与 Kimi Code。基于飞书官方 SDK 长连接，支持原生话题、流式卡片与文档评论，无需公网服务器。",
      eyebrow: "Mingle · 飞书 / Lark",
      h1: "飞书本地接入 Claude Code 和 Codex，<br><span>扫码直连，没有服务器。</span>",
      lead: "用飞书手机扫一下二维码，即可通过飞书官方 SDK 长连接把本机 coding agent 接进飞书私聊、群聊和云文档评论。无需公网回调地址，已在真实飞书租户验证。",
      transportNote: "飞书官方 SDK · 扫码创建与长连接 · 真实租户已验证",
      steps: [
        [
          "在 Mingle 控制台用飞书扫码",
          "点击连接飞书，手机飞书扫一下屏幕上的二维码即可完成官方机器人注册，不用手动填一堆回调 URL 和事件加密配置。",
        ],
        [
          "本机直连飞书官方长连接",
          "应用凭据仅保存在系统钥匙串里，Mingle 直接从你的电脑向飞书建立官方长连接，不需要公网服务器或内网穿透。",
        ],
        [
          "在私聊、群聊、话题和文档里直接 @ 它",
          "扫码的人自动成为 Agent 的 owner。在工作群里 @ 它交办任务，看流式进度卡片和原生话题，也能在飞书文档评论里直接召唤它。",
        ],
      ],
      worksTitle: "已在真实飞书租户里完整跑通。",
      highlights: [
        [
          "官方扫码与长连接，零服务器",
          "不用买云服务器，不用配公网回调域名，也没有第三方中转服务器接触你公司的飞书消息。",
        ],
        [
          "流式卡片与原生话题并行",
          "长任务会在你的消息下开一个飞书原生话题并持续刷新进度卡片，同时主群里其他人问简单问题照样几秒秒回。",
        ],
        [
          "支持飞书文档评论与文件收发",
          "除了群聊和私聊，还支持在飞书文档的评论区回复讨论、读取群成员列表，以及双向收发文件。",
        ],
        [
          "与微信、Slack、GitHub 共享记忆",
          "同一个 Agent 同时接进飞书和微信后，下班路上在微信里也能直接问它「今天上午飞书群里定了什么」。",
        ],
      ],
      faq: [
        [
          "飞书接入 Claude Code 需要公网服务器或回调地址吗？",
          "不需要。Mingle 使用飞书官方 SDK 的长连接模式，直接从你的电脑接收事件并回复，不需要任何公网服务器或域名。",
        ],
        ["同时支持国内版飞书和国际版 Lark 吗？", "支持。适配器基于官方 SDK 实现，采用扫码注册与长连接。"],
        [
          "飞书里的聊天记录和密钥安全吗？",
          "Mingle 没有自己的服务端、账号和遥测，完全运行在你的电脑上（127.0.0.1），机器人密钥只存在系统钥匙串中，Agent 记忆文件全部留在本地硬盘。",
        ],
      ],
    },
    wechat: {
      title: "微信本地接入 Claude Code 与 Codex（无服务器）· Mingle",
      description:
        "微信扫码把本机 Claude Code、Codex、OpenCode、Kimi Code 接进微信私聊。官方机器人通道本机长轮询，支持收发文件与跨软件记忆，无需云服务器。",
      eyebrow: "Mingle · 微信",
      h1: "微信本地接入 Claude Code 和 Codex，<br><span>扫码直连，没有服务器。</span>",
      lead: "在 Mingle 里用微信扫一下二维码，就能直接在微信里和你电脑上的 coding agent 对话。走官方机器人长轮询通道，没有云端中转，并与其他聊天软件共享同一份记忆。",
      transportNote: "微信官方机器人扫码 · 本机长轮询 · 支持私聊与双向文件",
      steps: [
        [
          "在 Mingle 里点击连接微信",
          "在桌面应用或本地控制台打开你的 Agent，选择微信，界面会生成一个官方机器人登录二维码。",
        ],
        [
          "用手机微信扫码确认",
          "扫码后，Mingle 把凭据安全存入系统钥匙串，并直接从你本机发起长轮询，不经过任何第三方中转服务器。",
        ],
        [
          "直接在微信里和你的 Agent 聊天",
          "扫码的人自动成为 owner。可以发文字也可以互传文件，还能随时在微信里问它之前在飞书、Slack、Discord 或 GitHub 记住的事情。",
        ],
      ],
      worksTitle: "把本机 coding agent 请进微信。",
      highlights: [
        [
          "官方机器人通道，没有云端桥接",
          "由你本机的 Mingle 直接长轮询官方机器人接口，不经过任何 Mingle 服务器，也不需要注册额外账号。",
        ],
        [
          "扫码即用，凭据留在系统钥匙串",
          "不用配置复杂后台，手机扫一下就绑定好并认领 owner。凭据只存 macOS 钥匙串、Windows DPAPI 或 Linux Secret Service。",
        ],
        [
          "正在输入提示与双向文件传输",
          "Agent 思考时会显示输入状态，支持在微信里直接发送文档、图片并接收 Agent 生成的文件。",
        ],
        [
          "在微信里查飞书、Slack 或 GitHub 的事",
          "同一个 Agent 共用本地一份 ROLE.md 和 MEMORY.md，你在公司用飞书或 Slack 聊完，出门在微信里也能接着问。",
        ],
      ],
      faq: [
        [
          "我的微信消息会经过 Mingle 服务器吗？",
          "不会。Mingle 没有服务器、没有账号、没有遥测，完全运行在你自己的电脑上，直接与官方机器人接口通信。",
        ],
        [
          "微信支持私聊还是群聊？",
          "微信官方机器人通道目前支持与 Agent 1 对 1 私聊（含输入状态和双向文件收发）。如果需要在团队群里用，可以把同一个 Agent 同时接进飞书、企业微信、钉钉、Slack、Discord 或 Telegram，所有渠道共享同一份记忆。",
        ],
        [
          "在微信里用 Claude Code 或 Codex 需要额外付费吗？",
          "不需要。Mingle 是免费且 MIT 开源的本地程序，直接驱动你电脑上已有的订阅或 API key，不加收任何费用。",
        ],
      ],
    },
  },
};
