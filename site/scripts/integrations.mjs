// Bilingual integration landing pages for mingle.build (/<app>/ and /zh/<app>/).
// Keep English and Chinese in step, and keep every claim grounded in src/channels/.

export const integrationOrder = [
  "slack",
  "discord",
  "telegram",
  "imessage",
  "feishu",
  "wechat",
  "wecom",
  "dingtalk",
  "qq",
  "github",
];

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
    wecom: {
      title: "Connect Claude Code & Codex to WeCom Locally · Mingle",
      description:
        "Scan a QR code in WeCom (企业微信) to connect local Claude Code, Codex, OpenCode and Kimi Code over the official intelligent bot WebSocket SDK. Streaming replies, files, zero server.",
      eyebrow: "Mingle for WeCom",
      h1: "Claude Code & Codex in WeCom.<br><span>QR scan, no server.</span>",
      lead: "Scan once with WeCom to create an official intelligent bot and connect your local coding agent over WebSocket. Streaming live replies, group chats, and files—with zero cloud server.",
      transportNote: "Official WeCom bot SDK WebSocket · QR setup · Streaming replies & files",
      steps: [
        [
          "Scan the QR code with WeCom",
          "Pick WeCom in the Mingle console and scan the code on your phone to create and authorize an official WeCom intelligent bot—no public callback URL needed.",
        ],
        [
          "Connect outbound over the official WebSocket SDK",
          "Mingle saves the bot credentials only in your OS keychain (macOS Keychain, Windows DPAPI or Linux Secret Service) and opens an outbound WebSocket directly from your machine.",
        ],
        [
          "DM or @-mention your agent in WeCom groups",
          "Whoever scans the code becomes the owner. Ask questions directly or @ the bot in team groups and watch answers stream in live as your local agent works.",
        ],
      ],
      worksTitle: "Built for WeCom DMs and team groups.",
      highlights: [
        [
          "Official intelligent bot WebSocket, zero server",
          "Uses the official WeCom AI bot Node SDK over an outbound WebSocket from your computer—no public webhook domain, no reverse proxy, and no Mingle relay.",
        ],
        [
          "Streaming live replies",
          "Replies stream directly into the WeCom message while your agent thinks and runs tools, then hand over cleanly to a follow-up message if a task runs long.",
        ],
        [
          "Direct chats, group chats and two-way files",
          "Works in 1-on-1 chats and WeCom groups, with quote replies and encrypted image/file download and upload handled locally.",
        ],
        [
          "Shared memory across WeCom, WeChat & GitHub",
          "Connect the same local agent to WeCom, WeChat, Feishu, Slack or GitHub so it remembers work context everywhere with one ROLE.md and MEMORY.md.",
        ],
      ],
      faq: [
        [
          "Do I need a public IP or callback URL to connect WeCom?",
          "No. Mingle uses the official WeCom intelligent bot WebSocket SDK, so your computer initiates the connection outbound without exposing any HTTP endpoint.",
        ],
        [
          "Does WeCom support both direct messages and group chats?",
          "Yes. You can message the bot directly or add it to WeCom groups, with streaming replies and two-way file and image support.",
        ],
        [
          "Where are my WeCom credentials and company chat data stored?",
          "Bot credentials are stored only in your OS keychain, and Mingle runs locally on 127.0.0.1 with no Mingle server or telemetry.",
        ],
      ],
    },
    dingtalk: {
      title: "Connect Claude Code & Codex to DingTalk Locally · Mingle",
      description:
        "Connect Claude Code, Codex, OpenCode and Kimi Code to DingTalk via QR device registration and DingTalk Stream WebSocket. Live AI cards, files, and zero public server.",
      eyebrow: "Mingle for DingTalk",
      h1: "Claude Code & Codex in DingTalk.<br><span>Stream mode, no server.</span>",
      lead: "Scan a QR code in DingTalk to register a bot and connect your local coding agent over official DingTalk Stream. Live AI progress cards, reactions, and files—no public webhook needed.",
      transportNote: "DingTalk Stream WebSocket · QR setup · AI progress cards & files",
      steps: [
        [
          "Scan with DingTalk to register the bot",
          "Pick DingTalk in the Mingle console and scan the QR code (or open the desktop link) to finish official device registration without manually wiring callback URLs.",
        ],
        [
          "Connect via DingTalk Stream from your machine",
          "Mingle stores the app credentials only in your OS keychain and opens an outbound DingTalk Stream WebSocket—no VPS, no public domain, no tunnel.",
        ],
        [
          "Chat in DingTalk DMs or @ in groups",
          "Whoever scans becomes the owner. Send text, voice transcripts, screenshots or files up to 20 MB and track progress live inside DingTalk AI cards.",
        ],
      ],
      worksTitle: "Native DingTalk Stream, live AI cards.",
      highlights: [
        [
          "DingTalk Stream, no public webhook",
          "Receives messages over the official DingTalk Stream client straight on your computer—no cloud host or public HTTPS endpoint to maintain.",
        ],
        [
          "Live AI cards and message reactions",
          "Your agent reacts immediately when a message arrives and streams live markdown updates through DingTalk's AI card while long tasks run on the side.",
        ],
        [
          "Direct chats, groups and two-way files",
          "Supports 1-on-1 messages and @-mentions in DingTalk groups, plus receiving and sending images and files up to 20 MB.",
        ],
        [
          "One local agent across every app",
          "Keep the same agent in DingTalk, WeChat, Feishu, Slack and GitHub with one local memory and your existing coding agent subscription.",
        ],
      ],
      faq: [
        [
          "Does DingTalk require a public server or HTTPS callback?",
          "No. Mingle connects through DingTalk Stream (outbound WebSocket), so everything runs on your own machine with no exposed ports.",
        ],
        [
          "Can the agent send and receive files in DingTalk?",
          "Yes. Mingle downloads incoming files and images for your local agent and uploads images and files up to 20 MB back into DingTalk chats.",
        ],
        [
          "Which coding agents can drive my DingTalk bot?",
          "Any of the 14 harnesses supported via OAR, including Claude Code, Codex, OpenCode and Kimi Code (tested end to end), using the subscription or API key you already have.",
        ],
      ],
    },
    qq: {
      title: "Connect Claude Code & Codex to QQ Locally · Mingle",
      description:
        "Bind a QQ bot by QR scan and drive it locally with Claude Code, Codex, OpenCode or Kimi Code over Tencent's official QQ Bot SDK WebSocket. Owner approval and zero server.",
      eyebrow: "Mingle for QQ",
      h1: "Claude Code & Codex in QQ.<br><span>QR bind, no server.</span>",
      lead: "Scan with QQ to bind an official QQ bot and run your local coding agent over Tencent's WebSocket gateway. Direct messages, @-mentions in groups, file transfer, and owner approval.",
      transportNote: "Official Tencent QQ Bot SDK · WebSocket gateway · Owner approval",
      steps: [
        [
          "Scan to bind an official QQ bot",
          "Select QQ in the Mingle console and scan the QR code with QQ (or enter AppID and AppSecret manually from q.qq.com) to authorize the official bot.",
        ],
        [
          "Connect outbound to the QQ WebSocket gateway",
          "Mingle stores AppID and AppSecret only in your OS keychain and connects over Tencent's official Node SDK gateway—no server or webhook needed.",
        ],
        [
          "Approve who can talk to your bot",
          "Whoever binds the bot (or sends the 6-digit claim code) is the owner. Because QQ bots can be reached publicly, new users and groups wait for your approval before the agent acts.",
        ],
      ],
      worksTitle: "Official QQ Bot SDK, safely gated by you.",
      highlights: [
        [
          "Official Tencent SDKs, zero cloud bridge",
          "Uses Tencent's official qqbot-connector for QR binding and qqbot-nodejs for the WebSocket gateway—running strictly on your computer.",
        ],
        [
          "Direct chats and group @-mentions",
          "Chat 1-on-1 with live typing notices or @ your agent in QQ groups. Long messages split automatically to respect QQ's length limits.",
        ],
        [
          "Two-way images and files",
          "Send screenshots and attachments from QQ for your local coding agent to inspect, and receive generated files or images back in the chat.",
        ],
        [
          "Owner approval for public chats",
          "New people or QQ groups never spend your coding agent's quota until you explicitly approve them in the console or chat.",
        ],
      ],
      faq: [
        [
          "Does Mingle use an unofficial QQ protocol or third-party bridge?",
          "No. Mingle uses Tencent's official QQ Bot SDKs (@tencent-connect/qqbot-connector and @tencent-connect/qqbot-nodejs) directly from your computer.",
        ],
        [
          "Can strangers use my QQ bot and burn my Claude Code or Codex quota?",
          "No. On public platforms like QQ, Telegram and Discord, any new user or group waits for the owner's explicit approval before the agent runs a turn.",
        ],
        [
          "Do I need a VPS to keep the QQ bot online?",
          "No. Mingle runs in your desktop app's menu bar or system tray on macOS, Windows or Linux, connecting outbound over WebSocket with no server required.",
        ],
      ],
    },
    github: {
      title: "Connect Claude Code & Codex to GitHub Issues & PRs Locally · Mingle",
      description:
        "Mention your local Claude Code, Codex or OpenCode agent in GitHub issues, pull requests and inline review threads. Polls the official Notifications API from your computer—no webhook or server.",
      eyebrow: "Mingle for GitHub",
      h1: "Claude Code & Codex in GitHub.<br><span>@mention in issues & PRs.</span>",
      lead: "Give your local coding agent its own GitHub account and @-mention it in issues, pull requests and inline review comments. Polls GitHub directly from your machine—no webhook, no GitHub App server.",
      transportNote: "GitHub REST Notifications API (ETag polling) · Trusted org/collaborators only",
      steps: [
        [
          "Sign in the agent's own GitHub account",
          "Pick GitHub in the Mingle console and authorize the agent's dedicated GitHub account via device code (or a classic personal access token with notifications and repo scopes).",
        ],
        [
          "Poll notifications locally with zero webhook",
          "Mingle saves the token in your OS keychain and polls the official GitHub Notifications API with ETag caching from your computer—no public URL or server to host.",
        ],
        [
          "@-mention your agent in issues, PRs and reviews",
          "Tag @your-agent in an issue, PR or inline code review thread. It reacts to acknowledge, runs on your local machine, and replies right inside the same issue or review thread.",
        ],
      ],
      worksTitle: "Built for issues, pull requests and code review.",
      highlights: [
        [
          "Zero webhook, ETag-friendly polling",
          "Polls GitHub's official REST Notifications API with ETag headers so idle checks cost zero rate limit—no webhook server, no ngrok, and no hosted CI runner needed.",
        ],
        [
          "Inline PR review threads stay in thread",
          "When you @-mention the agent on a specific diff line in a pull request review, its reply lands right back inside that exact inline review thread.",
        ],
        [
          "Trusted repo roles only (anti-abuse by design)",
          "On public or private repositories, Mingle only wakes the agent for comments from repository OWNER, MEMBER or COLLABORATOR accounts—drive-by mentions from strangers are ignored.",
        ],
        [
          "Same memory as your team's chat apps",
          "Your agent in GitHub is the exact same agent in Slack, Discord, Feishu, Telegram or WeChat—so a discussion in chat carries straight into the PR without re-explaining.",
        ],
      ],
      faq: [
        [
          "Do I need to host a GitHub App webhook server?",
          "No. Mingle polls the GitHub REST Notifications API directly from your computer using conditional ETag requests, so no public webhook endpoint is needed.",
        ],
        [
          "What stops random people on a public repo from triggering my local agent?",
          "Mingle checks each commenter's author_association and only acts on mentions from repository OWNER, MEMBER or COLLABORATOR accounts. Everyone else on a public repo is ignored.",
        ],
        [
          "Why does the agent use its own GitHub account?",
          "Using a dedicated machine account keeps @-mentions unambiguous, avoids self-notification loops, and makes it obvious in issue and PR history which comments came from the agent.",
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
    wecom: {
      title: "企业微信本地接入 Claude Code 与 Codex（无服务器）· Mingle",
      description:
        "企业微信扫码接入本机 Claude Code、Codex、OpenCode 与 Kimi Code。基于企业微信官方智能机器人 WebSocket SDK，支持流式回复、群聊与双向文件，无需公网服务器。",
      eyebrow: "Mingle · 企业微信",
      h1: "企业微信本地接入 Claude Code 和 Codex，<br><span>扫码直连，没有服务器。</span>",
      lead: "用企业微信扫一下二维码，即可通过官方智能机器人 WebSocket SDK 把本机 coding agent 接进企业微信私聊和群聊。支持流式实时回复与双向文件，无需公网回调地址。",
      transportNote: "企业微信官方智能机器人 WebSocket · 扫码绑定 · 流式回复与文件",
      steps: [
        [
          "用企业微信扫码创建智能机器人",
          "在 Mingle 控制台选择企业微信，用手机企业微信扫一下二维码完成官方机器人授权，不需要手动配置公网回调域名和加解密。",
        ],
        [
          "本机主动连向企业微信 WebSocket",
          "机器人凭据只存入系统钥匙串（macOS 钥匙串、Windows DPAPI 或 Linux Secret Service），Mingle 直接从你的电脑发起 WebSocket 长连接。",
        ],
        [
          "在私聊或企业微信群里直接交办任务",
          "扫码的人自动成为 owner。在私聊或工作群里提问、发文件，Agent 边干活边流式输出回复内容。",
        ],
      ],
      worksTitle: "把本机 coding agent 请进企业微信。",
      highlights: [
        [
          "官方智能机器人 SDK，零公网服务器",
          "基于企业微信官方 @wecom/aibot-node-sdk 长连接，不用买云服务器、不用开公网端口，也没有 Mingle 云端中转。",
        ],
        [
          "流式实时回复体验",
          "Agent 思考和执行期间，回答会以流式方式持续刷新进企业微信消息里，长任务超时前自动衔接续发。",
        ],
        [
          "支持私聊、群聊与双向加密文件",
          "同时支持单聊、群聊和引用回复，支持本地解密下载图片与文件，也能把生成结果直接发回企业微信。",
        ],
        [
          "与微信、飞书、GitHub 共享同一份记忆",
          "同一个 Agent 共用本地 ROLE.md 和 MEMORY.md，在企业微信群里讨论的上下文，回到微信或 GitHub 里也记得清清楚楚。",
        ],
      ],
      faq: [
        [
          "企业微信接入需要公网 IP 或回调域名吗？",
          "不需要。Mingle 使用企业微信官方智能机器人的 WebSocket 长连接，由你的电脑主动向外连接，不需要暴露任何公网接口。",
        ],
        [
          "企业微信支持群聊和私聊吗？",
          "都支持。可以直接和机器人单聊，也可以把它拉进企业微信群里使用，同时支持流式回复和双向图片/文件收发。",
        ],
        [
          "机器人密钥和公司聊天内容会上传到 Mingle 服务器吗？",
          "不会。Mingle 没有服务端、账号和遥测，完全运行在你的电脑（127.0.0.1）上，凭据只存在系统钥匙串中。",
        ],
      ],
    },
    dingtalk: {
      title: "钉钉本地接入 Claude Code 与 Codex（Stream 模式，无服务器）· Mingle",
      description:
        "钉钉扫码通过官方 Stream 长连接接入本机 Claude Code、Codex、OpenCode 与 Kimi Code。支持 AI 流式进度卡片、表情回应与 20MB 文件收发，无需公网服务器。",
      eyebrow: "Mingle · 钉钉",
      h1: "钉钉本地接入 Claude Code 和 Codex，<br><span>Stream 直连，没有服务器。</span>",
      lead: "用钉钉扫码完成官方设备注册，通过钉钉 Stream 长连接把本机 coding agent 接进钉钉私聊和群聊。支持流式 AI 进度卡片与双向文件，不需要公网回调地址。",
      transportNote: "钉钉官方 Stream 长连接 · 扫码注册 · AI 进度卡片与文件",
      steps: [
        [
          "用钉钉扫码完成机器人注册",
          "在 Mingle 控制台选择钉钉，用手机钉钉扫码（或直接点开桌面端链接）即可完成官方注册，不用手动配置繁琐的 webhook 回调。",
        ],
        [
          "本机直连钉钉 Stream 长连接",
          "应用凭据仅存系统钥匙串，Mingle 直接从你的电脑建立钉钉 Stream WebSocket 连接，不需要云服务器、域名或内网穿透。",
        ],
        [
          "在钉钉单聊或群里 @ 它干活",
          "扫码的人自动成为 owner。支持发送文字、语音转写、截图和文件，长任务会在钉钉 AI 卡片里实时刷新进度。",
        ],
      ],
      worksTitle: "原生钉钉 Stream，流式 AI 卡片实时看进度。",
      highlights: [
        [
          "官方 Stream 模式，零公网部署",
          "通过钉钉官方 dingtalk-stream 长连接直接在本地收消息，不依赖任何公网 HTTPS 回调或第三方桥接。",
        ],
        [
          "AI 进度卡片与消息回应",
          "收到消息先回表情确认，随后用钉钉 AI 卡片流式更新进度和结果；长任务在后台跑，主群快问照样秒回。",
        ],
        [
          "私聊、群聊与双向文件收发",
          "支持单聊与群聊 @ 触发，支持接收富文本/图片/文件，并可把最高 20 MB 的图片和文件发回钉钉。",
        ],
        [
          "复用已有订阅，跨软件共用记忆",
          "同一个本地 Agent 可以同时在线于钉钉、微信、飞书、Slack 和 GitHub，共用一份记忆和你已有的 Claude Code / Codex 订阅。",
        ],
      ],
      faq: [
        [
          "钉钉接入 Claude Code 需要公网服务器或回调 URL 吗？",
          "不需要。Mingle 走钉钉官方 Stream 长连接模式，完全在你的电脑上主动连接钉钉，不需要公网服务器或穿透工具。",
        ],
        [
          "支持在钉钉里收发文件和图片吗？",
          "支持。Mingle 会把钉钉发来的文件和图片下载给本机 Agent 处理，也支持把 Agent 生成的图片和文件（单文件最高 20 MB）发回群聊或私聊。",
        ],
        [
          "钉钉机器人可以用哪些 AI coding agent 驱动？",
          "支持通过 OAR 接入的全部 14 款 harness，其中 Claude Code、Codex、OpenCode、Kimi Code 已端到端验证，直接复用你已有的订阅或 API key。",
        ],
      ],
    },
    qq: {
      title: "QQ 本地接入 Claude Code 与 Codex（官方 SDK，无服务器）· Mingle",
      description:
        "QQ 扫码绑定官方机器人，通过腾讯官方 QQ Bot SDK WebSocket 在本机运行 Claude Code、Codex、OpenCode 或 Kimi Code。支持私聊、群聊 @、文件收发与 owner 审批。",
      eyebrow: "Mingle · QQ",
      h1: "QQ 本地接入 Claude Code 和 Codex，<br><span>官方扫码，没有服务器。</span>",
      lead: "用 QQ 扫一下二维码绑定腾讯官方机器人，在本机通过官方 WebSocket 网关驱动你的 coding agent。支持单聊、QQ 群 @ 触发、双向文件，以及针对陌生人的 owner 审批机制。",
      transportNote: "腾讯官方 QQ Bot SDK · WebSocket 网关 · 陌生人审批防滥用",
      steps: [
        [
          "用 QQ 扫码绑定官方机器人",
          "在 Mingle 控制台选择 QQ，用手机 QQ 扫码即可完成绑定（也支持在 q.qq.com 获取 AppID 与 AppSecret 后手动填写）。",
        ],
        [
          "本机直连腾讯官方 WebSocket 网关",
          "AppID 和 AppSecret 只保存在系统钥匙串中，Mingle 直接从你的电脑连接官方网关，不需要云服务器或公网回调。",
        ],
        [
          "认领 owner 并审批可对话的人和群",
          "扫码人（或私聊发送 6 位认领码的人）成为 owner。由于 QQ 机器人可能被公开搜到，新用户和新群需经你审批通过后 Agent 才会响应。",
        ],
      ],
      worksTitle: "腾讯官方机器人 SDK，额度安全可控。",
      highlights: [
        [
          "腾讯官方 SDK，无第三方非官方协议",
          "使用腾讯官方 @tencent-connect/qqbot-connector 扫码绑定与 @tencent-connect/qqbot-nodejs 长连接，不经过任何第三方中转服务器。",
        ],
        [
          "支持单聊输入状态与 QQ 群 @ 回复",
          "单聊处理期间会持续显示「正在输入」状态，群聊里 @ 它即可触发；超长回复会自动按 QQ 字数上限安全分段发送。",
        ],
        [
          "双向图片与文件传输",
          "可以把 QQ 里的截图和文件发给本机 Agent 阅读分析，Agent 生成的文件和图片也能直接发回 QQ 聊天。",
        ],
        [
          "陌生人与新群默认需审批",
          "未获 owner 批准的新人或新 QQ 群不会触发你的 coding agent，避免别人随意消耗你的模型订阅额度。",
        ],
      ],
      faq: [
        [
          "Mingle 接入 QQ 用的是官方接口还是第三方逆向协议？",
          "完全使用腾讯官方 QQ 机器人 SDK（qqbot-connector 与 qqbot-nodejs），稳定合规且直接运行在你自己的电脑上。",
        ],
        [
          "别人搜到我的 QQ 机器人会乱花我的模型额度吗？",
          "不会。对于 QQ、Telegram、Discord 这类公开平台，任何陌生人或新群发来消息时都会先等待你的 owner 审批，批准前 Agent 不会执行。",
        ],
        [
          "需要买云服务器挂着 QQ 机器人吗？",
          "不需要。Mingle 桌面端常驻 macOS 菜单栏或 Windows/Linux 系统托盘，在本机通过 WebSocket 保持在线，零服务器成本。",
        ],
      ],
    },
    github: {
      title: "在 GitHub Issue 与 PR 中本地接入 Claude Code 和 Codex · Mingle",
      description:
        "在 GitHub Issue、Pull Request 和行内 Code Review 评论里 @ 本机的 Claude Code、Codex 或 OpenCode。本机 ETag 轮询官方通知 API，无需 webhook 服务器，仅响应仓库成员。",
      eyebrow: "Mingle · GitHub",
      h1: "在 GitHub Issue 和 PR 里，<br><span>直接 @ 本机 Agent 干活。</span>",
      lead: "给你的本地 coding agent 配一个专属 GitHub 账号，在 Issue、Pull Request 和行内 Review 评论里直接 @ 它。本机通过 ETag 轮询官方通知接口，无需 webhook 服务器，也绝不响应陌生人。",
      transportNote: "GitHub REST 通知 API（ETag 零限额轮询）· 仅信任仓库 OWNER / MEMBER / COLLABORATOR",
      steps: [
        [
          "登录 Agent 专属的 GitHub 账号",
          "在 Mingle 控制台选择 GitHub，用验证码授权 Agent 自己的 GitHub 账号（或填入包含 notifications 与 repo 权限的 Classic PAT）。",
        ],
        [
          "本机低开销轮询，无需 webhook 服务器",
          "Token 仅保存在系统钥匙串里，Mingle 在你本机带 ETag 轮询 GitHub 官方通知 API——没有新动态时不消耗 API 限额，也无需暴露任何公网地址。",
        ],
        [
          "在 Issue、PR 和行内 Review 里 @ 它",
          "在任意 Issue、PR 或代码行评审线程里 @ 你的 Agent，它会先回表情表示收到，在你的电脑上完成分析或修改，然后直接回复在原线程里。",
        ],
      ],
      worksTitle: "专为 Issue、PR 和代码评审设计。",
      highlights: [
        [
          "无需 webhook，ETag 轮询省限额",
          "不需要搭 GitHub App 服务端或开 ngrok，Mingle 在本机使用条件 ETag 请求轮询官方通知接口，空闲时几乎零限额消耗。",
        ],
        [
          "PR 行内 Review 回复精准回到原线程",
          "在 Pull Request 某一行代码上发起 review 评论并 @ 它，Agent 的回复会直接落回那条行内评审线程，不会歪楼到主评论区。",
        ],
        [
          "开源仓库防滥用：只响应受信任成员",
          "Mingle 会校验评论者的 author_association，只响应仓库 OWNER、MEMBER 与 COLLABORATOR 的 @，公开仓库里陌生人的 @ 会被直接忽略。",
        ],
        [
          "与 Slack、飞书、Discord 共享同一份记忆",
          "GitHub 上的 Agent 和你工作群里的 Agent 是同一个，群里聊完的方案结论不用重复粘贴，在 PR 里 @ 它就能直接接着干。",
        ],
      ],
      faq: [
        [
          "接入 GitHub 需要自己搭建 Webhook 服务器或 GitHub App 吗？",
          "不需要。Mingle 直接从你的电脑轮询 GitHub 官方 REST 通知接口（带 ETag 缓存），完全不需要公网地址或云端服务器。",
        ],
        [
          "公开仓库里如果有陌生人 @ 我的 Agent 怎么办？",
          "Mingle 内置了权限过滤，只对仓库的 OWNER、MEMBER 和 COLLABORATOR 的评论触发执行，公开仓库中其他外部用户的 @ 会被自动忽略。",
        ],
        [
          "为什么建议给 Agent 使用独立的 GitHub 账号？",
          "独立账号可以让 @ 触发关系清晰无歧义、避免自己触发自己的通知循环，也能让团队在 Issue 和 PR 历史里一眼分辨哪些回复来自 Agent。",
        ],
      ],
    },
  },
};
