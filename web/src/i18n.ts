import { createContext, useContext } from "react";

const en = {
  "app.title": "Mingle",
  "agents.new": "New agent",
  "agents.empty": "Agents you create appear here.",
  "empty.title": "Bring an agent into your chat apps",
  "empty.body": "It runs on this computer, uses a harness you already have, and joins your groups as a bot.",
  "empty.action": "Create agent",
  "create.title": "New agent",
  "create.name": "Name",
  "create.namePlaceholder": "Alex",
  "create.role": "Role",
  "create.rolePlaceholder":
    "Who it is and what it does. For example: helps our hiking group plan routes and check the weather.",
  "create.brain": "Brain",
  "create.model": "Model",
  "create.modelDefault": "Harness default",
  "create.noHarness": "No supported harness was found. Install Claude Code or Codex, then reload.",
  "create.notice":
    "The agent acts with your access to this computer. Anything it learns in one chat it may repeat in another.",
  "create.submit": "Create",
  "create.cancel": "Cancel",
  "status.offline": "Offline",
  "status.idle": "Idle",
  "status.thinking": "Thinking",
  "status.working": "Working",
  "status.error": "Error",
  "agent.role": "Role",
  "agent.roleEmpty": "No role yet. Click to write one.",
  "agent.save": "Save",
  "agent.cancel": "Cancel",
  "agent.roleSaved": "Saved. It applies from the next message.",
  "agent.chatApps": "Chat apps",
  "agent.add": "Add",
  "agent.noConnections": "Not in any chat app yet.",
  "agent.activity": "Recent activity",
  "agent.noActivity": "Nothing yet. Messages to and from the agent appear here.",
  "agent.unanswered": "Not answered",
  "agent.tasks": "Tasks",
  "agent.reminders": "Reminders",
  "agent.openHome": "Open folder",
  "agent.stop": "Stop",
  "agent.stopped": "Stopped.",
  "agent.idleNothing": "It was not working on anything.",
  "agent.delete": "Delete",
  "agent.deleteConfirm": "Delete {name}? Its connections are removed. Its folder is kept.",
  "agent.deleteYes": "Delete",
  "agent.deleteNo": "Keep",
  "connection.connected": "Connected",
  "connection.reconnecting": "Reconnecting",
  "connection.awaiting_approval": "Waiting for admin approval",
  "connection.awaiting_credentials": "Not connected",
  "connection.error": "Error",
  "connection.noOwner": "Send it a direct message from your own account to become its owner.",
  "connection.remove": "Remove",
  "connect.title": "Add a chat app",
  "connect.soon": "Coming soon",
  "connect.connect": "Connect",
  "connect.connecting": "Connecting…",
  "connect.back": "Back",
  "telegram.token": "Bot token",
  "telegram.steps": "In Telegram, message @BotFather, send /newbot, and paste the token it gives you.",
  "settings.title": "Settings",
  "settings.language": "Language",
  "settings.appearance": "Appearance",
  "settings.system": "System",
  "settings.light": "Light",
  "settings.dark": "Dark",
  "auth.title": "Open the console from Mingle",
  "auth.body": "Run this in a terminal to open a signed-in console:",
  "error.offline": "Mingle is not running. Start it with `mingle start`.",
  "error.onboarding_invalid_credentials": "The chat app did not accept these credentials. Check them and try again.",
  "error.onboarding_network": "Could not reach the chat app. Check the network and try again.",
  "error.bot_in_use": "This bot is already connected to another agent.",
  "error.harness_unavailable": "That harness is not installed on this computer.",
  "error.name_required": "Give the agent a name.",
  "platform.wechat": "WeChat",
  "platform.wecom": "WeCom",
  "platform.feishu": "Feishu",
  "platform.dingtalk": "DingTalk",
  "platform.qq": "QQ",
  "platform.slack": "Slack",
  "platform.discord": "Discord",
  "platform.telegram": "Telegram",
} as const;

export type MessageKey = keyof typeof en;

const zh: Record<MessageKey, string> = {
  "app.title": "Mingle",
  "agents.new": "新建 Agent",
  "agents.empty": "创建的 Agent 会出现在这里。",
  "empty.title": "把 Agent 请进你的聊天软件",
  "empty.body": "它运行在这台电脑上，使用你已安装的 harness，以机器人身份加入你的群。",
  "empty.action": "创建 Agent",
  "create.title": "新建 Agent",
  "create.name": "名字",
  "create.namePlaceholder": "Alex",
  "create.role": "角色",
  "create.rolePlaceholder": "它是谁、做什么。例如：帮我们的徒步群规划路线、查天气。",
  "create.brain": "大脑",
  "create.model": "模型",
  "create.modelDefault": "harness 默认",
  "create.noHarness": "没有找到支持的 harness。安装 Claude Code 或 Codex 后刷新。",
  "create.notice": "Agent 以你的权限在这台电脑上执行操作。它在一个聊天里得知的内容，可能会在另一个聊天里说出来。",
  "create.submit": "创建",
  "create.cancel": "取消",
  "status.offline": "离线",
  "status.idle": "空闲",
  "status.thinking": "思考中",
  "status.working": "工作中",
  "status.error": "出错",
  "agent.role": "角色",
  "agent.roleEmpty": "还没有角色，点击编写。",
  "agent.save": "保存",
  "agent.cancel": "取消",
  "agent.roleSaved": "已保存，从下一条消息起生效。",
  "agent.chatApps": "聊天软件",
  "agent.add": "添加",
  "agent.noConnections": "还没有加入任何聊天软件。",
  "agent.activity": "最近活动",
  "agent.noActivity": "暂无。与 Agent 往来的消息会显示在这里。",
  "agent.unanswered": "未回复",
  "agent.tasks": "任务",
  "agent.reminders": "提醒",
  "agent.openHome": "打开文件夹",
  "agent.stop": "叫停",
  "agent.stopped": "已叫停。",
  "agent.idleNothing": "它当前没有在做事。",
  "agent.delete": "删除",
  "agent.deleteConfirm": "删除 {name}？它的连接会被移除，文件夹会保留。",
  "agent.deleteYes": "删除",
  "agent.deleteNo": "保留",
  "connection.connected": "已连接",
  "connection.reconnecting": "重连中",
  "connection.awaiting_approval": "等待管理员审核",
  "connection.awaiting_credentials": "未连接",
  "connection.error": "出错",
  "connection.noOwner": "用你自己的账号给它发一条私聊，你就成为它的 owner。",
  "connection.remove": "移除",
  "connect.title": "添加聊天软件",
  "connect.soon": "即将支持",
  "connect.connect": "连接",
  "connect.connecting": "连接中…",
  "connect.back": "返回",
  "telegram.token": "Bot token",
  "telegram.steps": "在 Telegram 里给 @BotFather 发 /newbot，把它给你的 token 粘贴到这里。",
  "settings.title": "设置",
  "settings.language": "语言",
  "settings.appearance": "外观",
  "settings.system": "跟随系统",
  "settings.light": "浅色",
  "settings.dark": "深色",
  "auth.title": "请从 Mingle 打开控制台",
  "auth.body": "在终端里运行下面的命令，打开已登录的控制台：",
  "error.offline": "Mingle 没有在运行。用 `mingle start` 启动。",
  "error.onboarding_invalid_credentials": "聊天软件没有接受这些凭据，请检查后重试。",
  "error.onboarding_network": "连不上聊天软件，请检查网络后重试。",
  "error.bot_in_use": "这个机器人已经接入了另一个 Agent。",
  "error.harness_unavailable": "这台电脑上没有安装这个 harness。",
  "error.name_required": "请给 Agent 起个名字。",
  "platform.wechat": "微信",
  "platform.wecom": "企业微信",
  "platform.feishu": "飞书",
  "platform.dingtalk": "钉钉",
  "platform.qq": "QQ",
  "platform.slack": "Slack",
  "platform.discord": "Discord",
  "platform.telegram": "Telegram",
};

export type Locale = "en" | "zh-CN";
export const catalogs: Record<Locale, Record<MessageKey, string>> = { en, "zh-CN": zh };

export function detectLocale(): Locale {
  const saved = localStorage.getItem("mingle.locale");
  if (saved === "en" || saved === "zh-CN") return saved;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

/** A known error code in the user's language; otherwise the server's own English explanation. */
export function errorText(t: Translate, error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const key = `error.${String(error.code)}`;
    if (key in en) return t(key as MessageKey);
    if ("next" in error && error.next) return String(error.next);
  }
  return String(error);
}

export type Translate = (key: MessageKey, vars?: Record<string, string>) => string;

export const I18n = createContext<{ t: Translate; locale: Locale; setLocale: (l: Locale) => void }>({
  t: (key) => en[key],
  locale: "en",
  setLocale: () => {},
});

export const useI18n = () => useContext(I18n);

export function translator(locale: Locale): Translate {
  const catalog = catalogs[locale];
  return (key, vars) => {
    let text = catalog[key] ?? en[key];
    for (const [k, v] of Object.entries(vars ?? {})) text = text.replace(`{${k}}`, v);
    return text;
  };
}
