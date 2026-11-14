# IM 真机冒烟

发正式版前，或者改动了某个平台渠道（`src/channels/<平台>/`）之后，跑一遍本清单。
目的不是全覆盖，而是确认"消息真的进得来、回复真的发得出去"这条链路在真机上没坏。

前提：

- 本机跑着一个 Mingle（`pnpm build && node dist/cli/main.js start`，或桌面应用），里面有一个 Agent。
- 每个平台的机器人已经在控制台里连上（凭据在系统 Keychain，不要把 token 贴到聊天或提交里）。
- 本机装了对应的 IM 客户端，用它们发消息最接近真实用户。

## 每个平台的检查

对每一个已连接的平台，用它的客户端完成下面三步：

1. **私聊冒烟**：给机器人发 `Reply with exactly: PONG`，应在一两分钟内收到包含 `PONG` 的回复。
2. **连续消息**：不等回复连发两条不同的问题（比如"1+1 等于几"和"今天星期几"），两条都应得到回复，不应丢。
3. **文件**：发一张图片或一个小文件，Agent 应能感知并回复（具体表现视平台能力，见 `docs/spec.md` 11.2）。

群聊能力的平台（飞书、企业微信、钉钉、QQ、Slack、Discord）再加一步：在群里 @机器人问一句，应回复；不 @ 时不应回复。

平台差异备注：

- 个人微信只支持私聊，没有表情回执，用"正在输入"代替。
- QQ 群聊没有流式和表情，直接回复。
- Slack、Discord 在频道里要 @ 或回复机器人才触发。
- 企业微信机器人创建只能在手机上完成。
- iMessage 没有引用回复、表情回执和"正在输入"，回复是普通消息（`docs/spec.md` 6.6）。

## iMessage（个人账号）

iMessage 不是机器人通道，准备和检查都不一样（`docs/spec.md` 6.6）：

准备：

1. 一台 Mac（或一个单独的 macOS 用户），「信息」App 登录 **Agent 专用的 Apple ID**，不要用自己的。
2. 系统设置 → 隐私与安全性 → 完全磁盘访问权限，打开 Mingle（桌面应用）或运行 `mingle start` 的终端。
3. 另一部用自己 Apple ID 的 iPhone 或 Mac，用来扮演 owner；再拉一个人（或第二个 Apple ID）建一个三人群。

检查（每步记下时间和结果）：

1. **接入和主动发消息**：控制台选 iMessage，填 owner 的手机号（带 +86 等国家码）或 Apple ID 邮箱，点连接；macOS 问是否允许控制「信息」时选允许。几秒内 owner 应收到 Agent 的问候私聊。用 owner 自己的 Apple ID 接入应被拒绝（`owner_account`）。
2. **私聊**：owner 发 `Reply with exactly: PONG`，应收到 `PONG`。再连发两条问题，两条都应回复。
3. **群聊 @**：群里不提 Agent 发一句，120 秒内不应回复；用 iMessage 的 @ 提及 Agent（或以 Agent 名字开头）问一句，应在群里回复。
4. **文件**：owner 发一张图片，Agent 应能描述它；让 Agent 发回一个文本文件，owner 应能打开。
5. **断线重连**：退出 Mingle，owner 发一条 `OFFLINE-PONG`，两分钟内重新启动，应收到回复；Mingle 运行中退出再打开「信息」App，之后发的消息仍应回复。
6. **权限收回**：关掉完全磁盘访问权限后重启 Mingle，连接应显示需要用户处理（`permission_missing`），重新打开权限、点"重新连接"后恢复。

## 收尾检查

所有消息发完后跑：

```sh
node scripts/im-smoke-check.mjs            # 默认看最近 30 分钟
node scripts/im-smoke-check.mjs --minutes 60
```

它读取 `~/.mingle/runtime.json`，逐个 Agent 检查有没有"收到但没回复"的入站消息。
全部答复输出 `all inbound messages answered`、退出码 0 才算过；
有 `unanswered` 就去看对应平台的连接状态和 `~/.mingle/logs/mingle.log`。

## 记录

跑完把结果记进 `docs/spec.md` 12.1（日期、平台、通过/失败、备注），
仍失败的项留在 12.2 待验证表里。
