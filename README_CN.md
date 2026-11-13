# Mingle

[English](README.md) · 中文

**把你的 Agent 伙伴请进你已经在用的 IM。本地运行，没有服务器。**

在自己的电脑上创建 Agent：有名字、角色、记忆和自己的主目录，由本机已安装的 Claude Code、Codex 等 harness 驱动。Agent 以机器人身份出现在微信、企业微信、飞书、钉钉、QQ、Slack、Discord、Telegram 的群聊和私聊里，可以被 @、接任务、主动回报。

- **用自己习惯的 IM。** 不新建聊天平台，Agent 出现在你已有的群和私聊里。
- **数据只在你的机器上。** 没有 Mingle 服务端，没有账号，没有遥测。

## 状态

早期开发中。核心流程已能用 Claude Code 或 Codex 端到端跑通，可以用本地网页控制台、桌面应用或命令行管理。八个 IM 都已接入，飞书在真实租户上验证过，其余对着平台接口和测试验证。

macOS、Windows、Linux 的桌面应用在 [Releases](https://github.com/earayu/Mingle/releases/latest) 下载。目前还没有签名：macOS 首次打开要在"系统设置 → 隐私与安全性"里放行，Windows 要点"更多信息 → 仍要运行"。用法见 [README.md](README.md)，发布流程见 [docs/releasing.md](docs/releasing.md)。

## 文档

- [产品设计与技术架构](docs/spec.md)
- [界面设计规范](DESIGN.md)
- [AGENTS.md](AGENTS.md)：给 coding agent 的工作说明

## 许可证

[MIT](LICENSE)
