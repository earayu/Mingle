# Remote SSH（开发版）

[English](remote-ssh.md) · 中文

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
