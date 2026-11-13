# Mingle

[English](README.md) · 中文 · [官网](https://mingle.build/zh/)

**把你的 Agent 伙伴请进你已经在用的 IM。本地运行，没有服务器。**

在自己的电脑上创建 Agent：有名字、角色、记忆和自己的主目录，由你已经在用的编码智能体驱动，比如 Claude Code、Codex、Cursor、OpenCode、Kimi Code、Qwen Code、DeepSeek Harness，以及 [OAR](https://github.com/botiverse/oar) 支持的其他 harness。Agent 以机器人身份出现在微信、企业微信、飞书、钉钉、QQ、Slack、Discord、Telegram 的群聊和私聊里，可以被 @、接任务、主动回报。

- **一个 Agent，所有聊天软件，同一份记忆。** 像一个真人一样，同一个 Agent 同时在你的飞书工作群、微信家庭群和 Discord 服务器里，而且都记得。在微信里问它"今天上午飞书群里定了什么"，或者让它把 Slack 里的一条消息转到 Telegram。
- **用自己习惯的 IM。** 不新建聊天平台，Agent 出现在你已有的群和私聊里。
- **用你已经付费的 Agent。** 跑在你已有的 harness 和订阅上，Mingle 不加模型，也不另收费。
- **数据只在你的机器上。** 没有 Mingle 服务端，没有账号，没有遥测。

## 状态

早期开发中。核心流程已能用 Claude Code、Codex、OpenCode、Kimi Code 端到端跑通，可以用本地网页控制台、桌面应用或命令行管理。没装的 harness 可以在应用里直接安装和登录。八个 IM 都已接入，飞书在真实租户上验证过，其余对着平台接口和测试验证。

macOS、Windows、Linux 的桌面应用在 [Releases](https://github.com/earayu/Mingle/releases/latest) 下载。macOS 版已经过 Apple 签名和公证。Windows 版还没有签名，要点"更多信息 → 仍要运行"。用法见 [README.md](README.md)，发布流程见 [docs/releasing.md](docs/releasing.md)。

## 文档

- [产品设计与技术架构](docs/spec.md)
- [界面设计规范](DESIGN.md)
- [AGENTS.md](AGENTS.md)：给 coding agent 的工作说明

## 许可证

[MIT](LICENSE)
