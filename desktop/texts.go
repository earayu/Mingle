package main

import (
	"fmt"
	"strings"

	"github.com/egoist/mygo"
)

// texts are the app's own words, in the menu bar, dialogs and notifications, in
// the system's language: Chinese or English, as the console (web/src/i18n.ts).
type texts struct {
	zh bool

	starting, restarting, running, stopped   string
	open, logs, openAtLogin, keepAwake, quit string
	noChatApps                               string
	quitTitle, quitButton, cancel            string
	closeHintTitle, closeHintBody            string
	errorBody, failedBody, downBody          string
}

func newTexts() texts {
	for _, lang := range mygo.App.PreferredLanguages() {
		if strings.HasPrefix(lang, "zh") {
			return zhTexts()
		}
		if strings.HasPrefix(lang, "en") {
			break
		}
	}
	return enTexts()
}

func zhTexts() texts {
	return texts{
		zh:             true,
		starting:       "Mingle 正在启动…",
		restarting:     "Mingle 已停止，正在重新启动。",
		running:        "Mingle 正在运行",
		stopped:        "Mingle 已停止",
		open:           "打开 Mingle",
		logs:           "查看日志",
		openAtLogin:    "登录时打开",
		keepAwake:      "插电时保持唤醒",
		quit:           "退出 Mingle",
		noChatApps:     "还没有连接聊天软件",
		quitTitle:      "退出 Mingle？",
		quitButton:     "退出",
		cancel:         "取消",
		closeHintTitle: "Mingle 仍在运行",
		closeHintBody:  "Agent 会继续回复消息。在托盘图标上点右键可以退出；把图标拖到任务栏上可以一直看到它。",
		errorBody:      "打开 Mingle 查看原因。",
		failedBody:     "打开 Mingle，问题解决后点重试。",
		downBody:       "Mingle 正在重新连接，电脑联网后会自动恢复。",
	}
}

func enTexts() texts {
	return texts{
		starting:       "Mingle is starting…",
		restarting:     "Mingle stopped and is restarting.",
		running:        "Mingle is running",
		stopped:        "Mingle has stopped",
		open:           "Open Mingle",
		logs:           "Show Logs",
		openAtLogin:    "Open at Login",
		keepAwake:      "Stay Awake on Power",
		quit:           "Quit Mingle",
		noChatApps:     "No chat app connected",
		quitTitle:      "Quit Mingle?",
		quitButton:     "Quit",
		cancel:         "Cancel",
		closeHintTitle: "Mingle is still running",
		closeHintBody:  "Your agents keep answering. Right-click the icon in the notification area to quit; drag it onto the taskbar to keep it in sight.",
		errorBody:      "Open Mingle to see why.",
		failedBody:     "Open Mingle to retry once the problem is fixed.",
		downBody:       "Mingle keeps reconnecting; it comes back once the computer is online.",
	}
}

func (t texts) plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return fmt.Sprintf(many, n)
}

// runningOnline is the first line of the menu.
func (t texts) runningOnline(online int) string {
	if online == 0 {
		return t.running
	}
	if t.zh {
		return fmt.Sprintf("Mingle 正在运行 · %d 个 Agent 在线", online)
	}
	return t.running + " · " + t.plural(online, "1 agent online", "%d agents online")
}

func (t texts) toolTip(online, needs int) string {
	switch {
	case needs > 0 && t.zh:
		return fmt.Sprintf("Mingle — 需要处理 %d 项", needs)
	case needs > 0:
		return "Mingle — " + t.plural(needs, "1 thing needs you", "%d things need you")
	case t.zh:
		return fmt.Sprintf("Mingle — %d 个 Agent 在线", online)
	default:
		return "Mingle — " + t.plural(online, "1 agent online", "%d agents online")
	}
}

func (t texts) needs(n int) string {
	if t.zh {
		return fmt.Sprintf("需要处理（%d）", n)
	}
	return fmt.Sprintf("Needs You (%d)", n)
}

func (t texts) others(n int) string {
	if t.zh {
		return fmt.Sprintf("其他 %d 个", n)
	}
	return fmt.Sprintf("%d More", n)
}

func (t texts) restartToUpdate(version string) string {
	if t.zh {
		return "重启以更新到 " + version
	}
	return "Restart to Update to " + version
}

// status names an agent's state as the console does (docs/spec.md 4.8).
func (t texts) status(status string) string {
	zh := map[string]string{"idle": "空闲", "thinking": "思考中", "working": "工作中", "error": "出错", "offline": "离线", "paused": "已暂停"}
	en := map[string]string{"idle": "Idle", "thinking": "Thinking", "working": "Working", "error": "Error", "offline": "Offline", "paused": "Paused"}
	names := en
	if t.zh {
		names = zh
	}
	if name, ok := names[status]; ok {
		return name
	}
	return status
}

func (t texts) workingOn(task string) string {
	if t.zh {
		return "工作中：" + task
	}
	return "Working: " + task
}

func (t texts) offlineBecause(reason string) string {
	if t.zh {
		return "离线：" + reason
	}
	return "Offline: " + reason
}

func (t texts) platform(p string) string {
	zh := map[string]string{"wechat": "微信", "wecom": "企业微信", "feishu": "飞书", "dingtalk": "钉钉"}
	en := map[string]string{"wechat": "WeChat", "wecom": "WeCom", "feishu": "Feishu", "dingtalk": "DingTalk"}
	other := map[string]string{"qq": "QQ", "slack": "Slack", "discord": "Discord", "telegram": "Telegram"}
	if name, ok := other[p]; ok {
		return name
	}
	names := en
	if t.zh {
		names = zh
	}
	if name, ok := names[p]; ok {
		return name
	}
	return p
}

// connection says what is wrong with a chat app's connection, or "" when nothing is.
func (t texts) connection(platform, state string) string {
	name := t.platform(platform)
	if t.zh {
		switch state {
		case "error":
			return name + "连接出错"
		case "awaiting_approval":
			return name + "等待管理员审核"
		case "reconnecting":
			return name + "正在重新连接"
		case "awaiting_credentials":
			return name + "还没连上"
		}
		return ""
	}
	switch state {
	case "error":
		return name + " connection failed"
	case "awaiting_approval":
		return name + " waiting for admin approval"
	case "reconnecting":
		return name + " reconnecting"
	case "awaiting_credentials":
		return name + " not connected yet"
	}
	return ""
}

func (t texts) failed(n int) string {
	if t.zh {
		return fmt.Sprintf("%d 条消息因为出错没有回复", n)
	}
	return t.plural(n, "1 message not answered because of an error", "%d messages not answered because of an error")
}

func (t texts) unanswered(n int) string {
	if t.zh {
		return fmt.Sprintf("%d 条消息没有回复", n)
	}
	return t.plural(n, "1 message not answered", "%d messages not answered")
}

// names lists agents as a sentence does: "Alex、Bob" or "Alex and Bob".
func (t texts) names(names []string) string {
	if t.zh {
		return strings.Join(names, "、")
	}
	switch len(names) {
	case 0:
		return ""
	case 1:
		return names[0]
	default:
		return strings.Join(names[:len(names)-1], ", ") + " and " + names[len(names)-1]
	}
}

func (t texts) quitDetail(names []string) string {
	if t.zh {
		return "退出后，" + t.names(names) + " 将不再回复消息，直到再次打开 Mingle。"
	}
	return t.names(names) + " will stop answering until you open Mingle again."
}

func (t texts) errorTitle(agent, platform string) string {
	if t.zh {
		return agent + " 的" + t.platform(platform) + "连接出错"
	}
	return agent + ": " + t.platform(platform) + " connection failed"
}

func (t texts) approvedTitle(platform string) string {
	if t.zh {
		return t.platform(platform) + "已通过审核"
	}
	return t.platform(platform) + " approved"
}

func (t texts) approvedBody(agent, platform string) string {
	if t.zh {
		return agent + " 现在可以在" + t.platform(platform) + "里回复了。"
	}
	return agent + " can answer in " + t.platform(platform) + " now."
}

func (t texts) downTitle(agent, platform string, minutes int) string {
	if t.zh {
		return fmt.Sprintf("%s 的%s已断开 %d 分钟", agent, t.platform(platform), minutes)
	}
	return fmt.Sprintf("%s: %s disconnected for %d minutes", agent, t.platform(platform), minutes)
}

func (t texts) failedTitle(agent string) string {
	if t.zh {
		return agent + " 有消息没能回复"
	}
	return agent + " could not answer a message"
}
