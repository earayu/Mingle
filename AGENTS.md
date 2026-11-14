# AGENTS.md

给在本仓库工作的 coding agent 的说明。

## 项目

Mingle 让用户在本机创建长期存在的 Agent 伙伴，由本机的 Claude Code、Codex 等 harness 驱动，以机器人身份加入微信、企业微信、飞书、钉钉、QQ、Slack、Discord、Telegram，或用 Agent 自己的个人账号接入 iMessage。本地运行，没有服务端。不预设公司或工作场景。

注意区分两个"agent"：读本文件的你是开发 Mingle 的 coding agent；文档里的 Agent 指 Mingle 的产品对象。

**开始任何工作前先读 [`docs/spec.md`](docs/spec.md)。** 它是产品范围、领域模型、架构和技术选型的唯一依据。做界面前再读 [`DESIGN.md`](DESIGN.md)，它是视觉和交互的唯一依据。

## 当前状态

M3 进行中，进度见 `docs/spec.md` 11.1–11.3。已实现：存储、Agent 运行时、本地 API、`mingle` CLI、控制台（`web/`）、全部八个平台的适配器和文件收发、iMessage 个人账号适配器（只在 macOS 上注册）、macOS 桌面应用（`desktop/`）。

代码地图：

- `src/core/mingle.ts`：整个进程的装配，收消息（inbox）、连接管理、提醒触发
- `src/core/runtime.ts`：每个 Agent 的会话与消息投递，`docs/spec.md` 4.1–4.3 的实现
- `src/core/outbox.ts`：所有对外发送
- `src/core/inbound.ts`：入站消息状态机，所有状态写入经 `Store.moveInbound`（`docs/spec.md` 4.10）
- `src/api/server.ts`：本地 HTTP API，`/v1/agent/*` 给 CLI，`/v1/admin/*` 给 owner
- `src/cli/main.ts`：`mingle` 命令；`src/cli/manual.md` 是注入给 harness 的指南
- `src/harness/harness.ts`：唯一引用 OAR 的地方
- `src/channels/`：`channel.ts` 是适配器接口，每个平台一个目录
- `web/`：控制台，React + Vite + Tailwind。视觉只用 `web/src/styles.css` 里来自 `DESIGN.md` 的 token；文案只走 `web/src/i18n.ts`，中英文两份都要加
- `desktop/`：桌面应用（macOS、Windows、Linux），mygo（Go）写的托盘壳，内置 Node 运行 `mingle start`，见 `docs/spec.md` 9.1。`desktop/scripts/prepare.mjs` 把 Mingle 和 Node.js 放进 `desktop/resources/`
- `site/`：官网 mingle.build，静态页面（中英文）和 `llms.txt`，由 `site/scripts/build.mjs` 生成，部署见 `site/README.md`。控制台改版后用 `site/scripts/screenshots.mjs` 重拍截图
- `spikes/`：技术验证脚本，不属于产品代码

## 不可违背的产品约束

1. **没有服务端。** 不引入任何云端组件、账号、遥测或对外上报。本地 HTTP 服务只监听 `127.0.0.1`。
2. **Agent 是一等对象。** 不向 IM 用户暴露 harness 会话，不加 `/new`、`/switch` 这类会话命令。
3. **优先官方机器人通道；个人账号必须属于 Agent。** 平台有能用的机器人通道就用它。没有时可以在本机用个人账号接入，但账号必须是 Agent 专用的（专用 Apple ID、专用号码），不能让 Agent 以 owner 本人的身份说话；不使用云端桥接。身份和安全边界见 `docs/spec.md` 6.6。
4. **不自己实现 agent 循环。** 模型调用和工具执行交给 harness，通过 OAR 接入。
5. **密钥不落库、不进日志、不出现在 API 响应里。** IM 凭据只存系统 Keychain。

改动会触及这些约束时，停下来先和维护者确认。

## 技术栈

- TypeScript（ESM），Node.js 24+，pnpm
- harness：`@botiverse/oar`，锁定版本
- 存储：`node:sqlite` 和本地文件
- 本地 API：Hono；控制台：React + Vite + Tailwind
- 测试：Vitest；检查：Biome
- 界面文案走消息目录，首批 `en` 和 `zh-CN`

## 目录约定

```text
src/core/       领域类型、Agent 运行时、收件箱、调度器
src/harness/    OAR 的薄封装
src/channels/   Channel 接口和各平台适配器，每个平台一个目录
src/store/      SQLite 访问和迁移
src/platform/   Keychain、自启等系统相关能力
src/api/        本地 HTTP API
src/cli/        mingle 命令和操作指南
web/            控制台
test/           测试
spikes/         技术验证脚本
docs/           文档
```

## 架构规则

- **OAR 只在 `src/harness/` 内被引用。** 其他模块依赖我们自己的接口。OAR 更新很快，这一层用来隔离变化。
- **平台 SDK 只在对应的 `src/channels/<平台>/` 内被引用。** 核心层只认 `Channel` 接口和语义类型，不出现平台名称的分支判断。
- **Agent 对 IM 的一切输出都经过 `mingle` CLI 和本地 API。** 不要在别处直接调用适配器发消息，权限检查集中在 API 层。
- **`mingle` CLI 保持小而稳定。** 新增命令先在 `docs/spec.md` 第 5 节定义。操作指南和注入给 harness 的提示词必须由同一份源生成。
- **Agent 主目录只约定 `ROLE.md`、`MEMORY.md`、`notes/`。** 不要让 Mingle 往里写别的文件。
- **系统相关代码只在 `src/platform/`。** 核心保持可在 Linux 上无界面运行。
- **渠道能力按机器人实例判断。** 新增呈现能力时同时写明不支持时的降级行为。
- 数据库结构变更通过迁移文件，不手改已有迁移。
- **长期存在的状态不能卡死，也不能被过期结果改乱。** 连接、消息、Agent 运行状态这类会持久化、有多个事件来源的状态，要能一眼看出它可以怎么变：任何非终态都有出路（会自己发生的下一步，或界面上用户能做的操作），迟到的异步结果不能覆盖更新的状态。规则分散在多处、开始互相矛盾时，收拢成显式状态机，参考 `src/core/link.ts`（docs/spec.md 6.4）。纯界面状态不必如此。

## 工作方式

- 改控制台后必须跑 `pnpm build && pnpm ui:review`，逐张看截图再提交：不允许文字被遮挡或截断到看不出意思、不允许横向溢出、不允许界面里出现英文内部错误码或未翻译的文案。

- 改动产品范围、领域模型、架构或技术选型时，先更新 `docs/spec.md`，与代码在同一次提交里。
- `docs/spec.md` 第 12 节的待验证项有了实测结论后，把结论写回文档并移出该节。
- 不凭记忆断言第三方 SDK 或平台的行为。查当前文档或源码，或实测；未实测的写明"待验证"。
- 新增依赖要有理由，优先用 Node 内置能力。
- 行为变更附带测试。Agent 运行时的测试用 OAR 的 `testing` 脚本化运行时，不依赖真实 harness 登录。
- 参考 Raft 源码时只学设计，不复制代码（FSL 许可）。从 dsh-im 移植代码时保留 MIT 署名。

## 提交

- 目前直接提交到 `main`。提交前 `pnpm check` 必须通过。
- 提交信息用英文，祈使句，说明做了什么和原因。
- 设计文档用中文；代码、标识符、注释、提交信息、CLI 输出、`src/cli/manual.md`、`README.md` 用英文。
- 提交前确认不包含任何凭据、token 或个人数据。

## 命令

```sh
pnpm install
pnpm check        # typecheck + lint + test，提交前必须通过
pnpm typecheck
pnpm lint
pnpm format       # 自动修复格式
pnpm test
pnpm build        # 先构建控制台（web/dist），再编译到 dist/
pnpm dev:web      # 控制台热更新开发，API 代理到正在运行的 mingle start
pnpm ui:review    # 先 pnpm build。用长名字、长文本和所有状态，在多个宽度 × 中英文下截图到 .ui-review/
MINGLE_E2E=claude,codex pnpm vitest run test/e2e.test.ts   # 用本机真实 harness 跑端到端，会消耗额度；条目可写 id:model 指定模型，长用例只给 MINGLE_E2E_DEEP（默认 claude,codex）跑
node scripts/package-smoke.mjs <安装包>   # 解包安装产物，验证内置 node 能跑 mingle --version 和 start（release.yml 的 smoke 作业在用）
node scripts/im-smoke-check.mjs           # 检查运行中的 Mingle 有没有"收到未回复"的消息（配合 docs/im-smoke.md 的真机冒烟）
pnpm desktop:build  # 构建桌面应用到 desktop/build/（需要 Go，go.mod 指定的版本会自动下载）
pnpm desktop:dev    # 用 go run 跑桌面壳，Node 用 PATH 上的，Mingle 用仓库的 dist/
```

本地手动运行：

```sh
pnpm build
MINGLE_HOME=/tmp/mingle-dev node dist/cli/main.js start      # 另开终端执行下面的命令
MINGLE_HOME=/tmp/mingle-dev node dist/cli/main.js agent create --name Alex --harness claude
echo "$BOT_TOKEN" | MINGLE_HOME=/tmp/mingle-dev node dist/cli/main.js connect alex telegram
```

TypeScript 只用可擦除语法（不用参数属性、enum、namespace）：Node 直接运行 `src/` 下的 `.ts`，测试里的 CLI 子进程也是这样跑的。

需要 Node.js 24 和 pnpm。TypeScript 源码里的相对导入写 `.ts` 后缀。
