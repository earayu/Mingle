# Mingle

[English](README.md) · 中文 · [官网](https://mingle.build/zh/)

**把你的 Agent 伙伴请进你已经在用的 IM。本地运行，没有服务器。**

在自己的电脑上创建 Agent：有名字、角色、记忆和自己的主目录，由你已经在用的编码智能体驱动，比如 Claude Code、Codex、Cursor、OpenCode、Kimi Code、Qwen Code、DeepSeek Harness，以及 [OAR](https://github.com/botiverse/oar) 支持的其他 harness。Agent 以机器人身份出现在微信、企业微信、飞书、钉钉、QQ、Slack、Discord、Telegram 的群聊和私聊里，也能用自己的 GitHub 账号在 issue 和 PR 里被 @，还可以在 Mac 的 iMessage 里通过给自己发消息和它聊，可以被 @、接任务、主动回报。

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

## 参与贡献

欢迎提 issue 和 PR，见 [CONTRIBUTING.md](CONTRIBUTING.md)（英文），issue 用中文写也可以。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可证

[MIT](LICENSE)

## Remote SSH（开发版）

在“新建 Agent → 运行位置 → 添加 SSH 主机”中，可直接选择从本机 ~/.ssh/config 读取
的 Host 别名（支持常见 Include 文件），也可手动输入别名或 user@host。修改配置后点击
“刷新”重新读取；读取列表不会连接主机。填写专用
远端数据目录，点击“准备并连接”。请先在终端完成 SSH 登录与主机信任。远端需要
Node.js 24+、npm、tar、首次安装依赖的网络，以及已登录的大脑。pnpm build 会生成
部署包；准备过程启动独立的远端 Mingle，不会自动升级已运行的远端实例。

缺少 Node.js 时，点击“安装远端环境 → 安装并连接”，客户端会通过 SSH 执行内置安装脚本，显示安装进度，成功后自动准备远端 Mingle。失败可重试，重复点击会复用正在运行的任务。手动安装命令保留在折叠区作为备用。[GitHub 上的脚本](https://github.com/gerayking/Mingle/blob/d0d35e92f3c8903690e47dff052e090572a9e088/scripts/install-remote.sh)
从 Node.js 官方下载固定版本并验证 SHA-256，将 Node.js 24 和 npm 安装到
~/.local/share/mingle/node，无需 sudo，不修改系统 Node 或 shell 配置。支持 Linux
（glibc）和 macOS 的 x64/arm64；需已有 curl、tar、gzip 和 sha256sum/shasum。
直接执行脚本时也支持 wget。Mingle 会在 SSH 命令中明确加入此运行时的 PATH，
不依赖 nvm 初始化。安装期间请保持本机 Mingle 运行；大脑仍需单独安装并登录。

远端保存 Agent、聊天连接、凭据和文件，默认数据目录为 ~/.mingle-remote。**本机
Mingle 退出、休眠或断网后，远端仍继续接收和回复消息。** 本机恢复后可继续管理；
SSH 不可达时显示的是上次信息，不代表远端已停止。远端文件夹和复制的交接命令
需要在远端使用，本机交接可使用“粘贴内容”。

远端主机需保持开机联网，且允许 SSH 登出后保留后台进程。本版提供 Mingle 进程
异常退出重启，尚未配置远端开机自启；主机重启后，在新建页选择已有主机并点击
“准备或重新连接”，或自行配置系统服务。日志位于远端数据目录的 ssh-service.log。
无 Secret Service 的 Linux 沿用仅本人可读写的 0600 凭据文件后备存储。

已使用独立 Mingle 进程、脚本化大脑和模拟聊天通道做隔离测试；真实主机联调待验证。
