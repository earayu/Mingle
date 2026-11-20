# RFC 0001 实现方案：群聊旁听 V2

- 状态：已 CR（DIYGod，改动见第 12 节），实现中：A（#173）、B 已合并
- 依据：[RFC 0001](0001-group-hearing-v2.md)（已接受）、[原型](0001-prototype.html)、`docs/spec.md` 4.2
- 基线：`main` @ `9d92991`（#171）

本文写清楚每个文件改什么、新类型和函数的签名、状态放在哪、怎么测、分几个 PR 合。数值都取自 RFC，这里不再论证。

## 0. 已拍板的决定

| 问题 | 决定 |
|---|---|
| RFC 3.5：插不插进正在跑的一轮 | 折中：**这一轮正在处理 i 的话**，i 又发了一句，才插进去；其他情况一律合并 |
| 活跃人数怎么算 | 过去 7 天在这个群（含它的线程）里说过话的不同的人，不算机器人，也不算 Agent 自己。每个群缓存 1 小时 |
| 默认档位 | 活跃人数 ≤ 5，或还没有数据：**快**；否则：**均衡**。"省"只能手动选 |
| 原型里 DIYGod 的两个问题 | **状态行保留**：一行文字回答"它现在会不会接话"，零交互。**档位放在每个群里**：不同群的人数差别大，不能一刀切；不改就按人数取默认 |
| E、令牌、被晾次数存在哪 | 只放内存，重启清零，和 V1 的退避计数一样。档位和别名落库 |

## 1. 总体结构

旁听节奏的计算从 `mingle.ts` 里抽出来，放进一个纯逻辑模块。`mingle.ts` 只负责接线：定时器、读写 store、交给 runtime。

```text
inbox ──► Mingle.overhear()  ──► HearingBook.observe()   记录这条话，算出何时交出
                │                      │
                │                      └─► Plan { dueAt, lane: "fast" | "slow" | "ride" | "steer" }
                ▼
          setTimeout(dueAt) ──► Mingle.hear() ──► HearingBook.handOver()   选出 ≤30 条，扣令牌
                                       │
                                       └─► runtime.enqueueText(Heard, { steer?, track })
turn ends ──► track.ended() ──► HearingBook.settle()   开没开口：E、被晾次数、退避
```

`HearingBook` 只依赖传进来的 `now` 和数据，不碰定时器、store 和 runtime。所以第 2 节的数学全部可以用假时钟做单元测试，和 `docs/rfc/0001-sim/` 里的 V3f 一一对照。

## 2. 新模块 `src/core/hearing.ts`

### 2.1 常量

`mingle.ts` 里现有的 `HEAR_*` 搬到这里，原名导出，测试和 `chat hear` 的范围校验都不受影响。新增：

```ts
export const ENGAGE_HALF_LIFE_MS = 120_000;   // E 每 2 分钟减半
export const ENGAGE_DAMP = 0.6;               // 一段没开口，这段里的人 E 打折
export const ENGAGE_MIN = 0.25;               // E 达到这个值才算"在聊"
export const NAME_BOOST = 0.8;                // 叫名字或别名
export const TURN_END = { k: 2, minMs: 3_000, maxMs: 12_000, defaultMs: 8_000, samples: 20, gapCapMs: 30_000 };
export const FAST_MAX_WAIT_MS = 15_000;
export const RIDE_HOLD_MS = 240_000;          // 有人在聊时，闲聊最多压 4 分钟
export const STEER_QUIET_MS = 2_000;          // 补充插进正在跑的一轮前，最多等 2 秒
export const STEER_LATE_MS = 10_000;          // 插入后这一轮这么快就结束，当作没读到，补交一次
export const PERSON_BUCKET = { cap: 3, refillMs: 600_000 };
export const TIERS = {
  save:     { cap: 2, refillMs: 1_200_000 },
  balanced: { cap: 4, refillMs: 600_000 },
  fast:     { cap: 8, refillMs: 300_000 },
} as const;
export type HearTier = keyof typeof TIERS;
export const SMALL_GROUP = 5;                 // 活跃人数不超过这个数，默认用"快"
```

### 2.2 状态

一个 `HearingBook` 管一个 Agent 的所有群。计时按聊天 ID（线程有自己的计时）；人（E、被晾次数、每人的桶、打字节奏）和全群的桶按群，所以一个人换到线程里刷，花的还是同一个桶。

```ts
interface Person {
  e: number; eAt: number;            // 上次更新时的 E 和时间，读的时候按半衰期折算
  ignored: number;                   // 连续被晾次数，Agent 回了他就清零
  tokens: number; tokensAt: number;  // 每人的桶
  gaps: number[]; lastAt?: number;   // 打字节奏：最近 20 个 < 30 秒的间隔
}
interface ChatHearing {
  pending?: { from: number; since: number; fastSince?: number; engaged: Set<string> };
  heardAt?: number;                  // 上一段交出的时间（原 Mingle.heardAt）
  unanswered: number;                // 慢通道的连续未答段数（原 Mingle.unanswered），只给退避用
}
interface GroupHearing {
  people: Map<string, Person>;       // key：发言人在平台上的 ID（senderId）。按群算：线程里的话也记在群上
  tokens: number; at: number;        // 全群的桶
}
```

`Mingle` 里原来的 `hearing` / `heardAt` / `unanswered` 三个 Map 收进这里。`Mingle.hearing` 只留定时器句柄：`Map<chatId, NodeJS.Timeout>`。

### 2.3 接口

```ts
export class HearingBook {
  constructor(private readonly opts: { pace: Pace; now: () => number });

  /** 人说了一句（已经过 gate、群开着听所有、没静音）。返回这段现在该何时交出、走哪条路。 */
  observe(input: {
    chatId: string; groupId: string; senderId: string; at: number;
    named: boolean;                    // 正文里叫了 Agent 的名字或别名（2.5）
    owner: boolean;
    tier: HearTier; every?: number;    // 群的档位；Agent 设的 --every
    handling: boolean;                 // 正在跑的这一轮是否在处理这个人在这个聊天里的话（第 4 节）
  }): Plan;

  /** 定时器到点，准备交出：返回这段的起点和在聊的人，并扣快速通道的预算。 */
  handOver(chatId: string, groupId: string): { from: number; engaged: ReadonlySet<string>; fast: boolean } | undefined;

  /** 交出的那一段跑完了一轮：Agent 回了谁（2.6），这段里有谁。 */
  settle(chatId: string, groupId: string, s: {
    fast: boolean; heard: ReadonlySet<string>; engaged: ReadonlySet<string>; answered: ReadonlySet<string>;
  }): void;

  /** 有人 @ 它或回复它（走了触发路径）：这个人 E = 1，被晾次数清零；这个聊天的退避清零。 */
  addressed(chatId: string, senderId: string): void;

  /** Agent 在这个聊天里开口了：被回的人 E = 1（2.6）。 */
  spoke(chatId: string, to: ReadonlySet<string>): void;

  /** 给控制台：这个群现在和谁在聊、慢通道的间隔。 */
  view(groupId: string, chatIds: readonly string[]): { live: string[]; slowedMs?: number };

  forget(chatIds: readonly string[], drop: boolean): void;   // 原 forgetHearing 的内存部分
}

export type Plan =
  | { lane: "fast"; dueAt: number }      // 在聊的人推动计时
  | { lane: "steer"; dueAt: number }     // 插进正在跑的一轮（第 4 节）
  | { lane: "ride"; dueAt: number }      // 有人在聊，闲聊随下一段一起交；最多压 4 分钟
  | { lane: "slow"; dueAt: number };     // V1 的节奏
```

### 2.4 `observe()` 的规则

1. 更新这个人的打字节奏：`at - lastAt < 30s` 时，把间隔记进 `gaps`，只留最近 20 个。
2. 叫了名字时，`e = max(e(now), 0.8 · 0.5^ignored)`。
3. 这个人**在聊**的条件：`e(now) ≥ 0.25`，自己的令牌 ≥ 1，全群令牌 ≥ 1，并且 `ignored < 2`。
4. 按下面的顺序选路：
   - 在聊，而且 `handling`：走 **steer**，`dueAt = at + STEER_QUIET_MS`。
   - 在聊：走 **fast**。`fastSince ??= at`，`engaged.add(sender)`。说完时间 `te = μ + 2σ`，限制在 3–12 秒；样本不足 3 个时用 8 秒。
     ```text
     quiet   = e·te + (1−e)·HEAR_QUIET_MS
     maxWait = e·15s + (1−e)·HEAR_MAX_WAIT_MS
     dueAt   = min(at + quiet, fastSince + maxWait)      // 不受两段间隔约束
     ```
   - 不在聊，但这个群里有别人在聊（`live` 只算满足第 3 条的人，这就是 V3f 的修正）：走 **ride**。不推后已经排好的计时；还没有计时时，`dueAt = max(V1 的结果, heardAt + RIDE_HOLD_MS)`。
   - 其他情况：走 **slow**，完全是 V1 的公式，包括退避和 `--every`。
5. `every` 有值（Agent 设了 `--every`）时，不走 fast、steer、ride，只走 slow。"只能调慢"不变。

### 2.5 叫名字的判定：`named`

纯函数 `nameIn(body, names)`，放在 `hearing.ts`：

- `names`：Agent 名、`connection.botName`、群的别名（第 6 节）。去重，忽略长度小于 2 的。
- 不区分大小写。拉丁字母的名字要求两边是词边界；中文直接子串匹配。
- 已经是 @ 的消息走触发路径，不会到这里。

### 2.6 "Agent 回了谁"

不在 outbox 里挂钩子，在 `settle()` 和 `observe()` 前同步一次即可。新增 store 方法：

```ts
/** Agent 在这个聊天里 `at` 之后发的话：引用了哪条（拿到被引用的人），notice 不算。 */
spokenSince(chatId: string, at: number): { createdAt: number; replyToSender: string | null }[]
```

- 带引用的：被引用消息的发送者算"回了"。
- 不带引用、直接发到群里的：算回了**这一轮交给它的话里**、这个聊天的在聊者。没有在聊者时，算回了这些话里最后发言的人。这一轮没交过这个聊天的话（比如它主动开口）时，不算回了谁。不能扩大到"这个群里所有在聊的人"：已经不说话的 B 会因为 Agent 回了 A 而一直被拉回 E = 1，B 的闲聊就一直走快速通道。
- 这样不碰 outbox，也覆盖 Agent 不走 `message reply`、直接 `message send` 的情况。

### 2.7 `settle()`

| 结果 | 影响 |
|---|---|
| Agent 开口了 | 被回的人（2.6）：E = 1，被晾次数清零；慢通道 `unanswered = 0` |
| Agent 没开口 | 这段里每个人：E ×0.6 |
| 没开口，并且走的是 fast（含 steer 的补交） | 预留的令牌不退；`engaged` 里每个人被晾次数 +1 |
| 没开口，并且是 steer | 不扣令牌；`engaged` 里每个人被晾次数 +1 |
| 没开口，并且走的是 slow 或 ride | 慢通道 `unanswered + 1`，退避和 V1 一样；不扣令牌 |

**令牌在交出时预留，开口了再退回。** 走 fast 的一段在 `handOver()` 时就扣 1 个全群令牌和 `engaged` 里每人 1 个；`settle()` 看到 Agent 开口了，全部退回。只在确认白花后才扣的话，同一个群的群聊和线程可能同时有几段在路上，每段交出时都看到"还有令牌"，桶会被透支，上限公式就不成立了。预留之后，同一时刻在路上的快速段也受桶约束，公式严格成立。

steer 不扣令牌：它插进已经在跑的一轮，不多花一轮。它的补交（4.2）才多花一轮，按 fast 处理，同样预留。

## 3. `mingle.ts` 的改动

- **`overhear()`**：gate 和静音判断不变。接着：
  1. 用 2.6 同步一次"Agent 回了谁"；
  2. 调 `book.observe()`；
  3. 按返回的 `dueAt` 重设这个聊天的定时器。ride 已经有计时时，不重设。
- **触发路径**（inbox 里 `this.unanswered.delete(chat.id)` 的两处）：改成 `book.addressed(chat.id, sender)`。
- **`hear()`**：
  1. 调 `book.handOver()` 拿到起点和在聊的人；
  2. 取消息时先取在聊的人说的话，再用最新的闲聊补满 30 条：store 新增 `backgroundFor(chatId, from, senders, limit)`；
  3. 合成 `Heard`（第 5 节），用 `runtime.enqueueText(text, { steer, track })` 交出；
  4. 在 `track.ended` 里调 `book.settle()`，并写日志（第 7 节）。
- **`gap()` / `unansweredIn()`**：删掉，逻辑进 `HearingBook`。
- **`hearingView()`**：返回值加字段，见第 6 节。
- **`setHearPace()` / `resetHearPace()` / `setListen()`**：调 `book.forget()`，语义不变。
- **`options.hearing`**：测试用的 `{ quietMs, maxWaitMs, gapMs }` 保留。再加可选的 `engage?: Partial<typeof ENGAGE…>`，测试可以把半衰期、令牌补充速度调短。

## 4. 插进正在跑的一轮（RFC 3.5）

### 4.1 runtime

`src/core/runtime.ts`：

- `enqueueText(text, track?)` 改成 `enqueueText(text, opts?: { track?: TextTrack; steer?: { chatId: string; people: readonly string[] } })`。所有调用点同步改，其他调用点都不带 `steer`。
- `flush()`：运行中原来只放行 `kind === "message"`。改成也放行带 `steer` 的 text。不带 `steer` 的提醒和说明照旧等下一轮，原来的注释和理由都保留。
- 新增 `handling(chatId, senderId): boolean`。当前这一轮交进去的输入里（触发的消息按 `store.message(id)` 查发送者，带 `steer` 或旁听的 text 按 `people`），有没有这个人在这个聊天里的话。
  - 集合在 `deliver` 时加入，在 `onTurnEnded` 时清空。
  - harness 回"queued"（不支持中途插入）的输入不算进当前这一轮。
- 旁听的 text 也带上 `people`（这段里在聊的人），这样"这一轮正在处理 i"对旁听来的话也成立。

### 4.2 防丢

插在一轮的末尾，可能被接收了但没被处理：runtime 里提醒类 text 不插进去，就是这个原因。所以对 steer 再加一道保险：

- harness 只告诉我们插进去了（`steered`），不告诉我们读没读。所以只在**插得太晚**时补交：这一轮在插入后 `STEER_LATE_MS`（10 秒）内就结束了，并且 Agent 在这个聊天里没有比这次插入更晚的发言，就把这个聊天按 0 安静窗口**重新排一次**。插入后这一轮又跑了 10 秒以上，就当它读到了、选择不说话，按 steer 的 `settle()` 处理。`hear()` 本来就从它上次开口之后取话，所以不会重复。
- 只补一次：同一段补过一次之后，降级为 slow。
- 补的这一次多花一轮，按 fast 预留令牌（2.7）；没有令牌时降级为 slow。不能免费：否则"插在末尾 → 补交"就成了绕开桶的口子。

### 4.3 不做

- 别人的话、闲聊：不插，照旧合并。
- 触发路径本来就会插进去，不动。

## 5. 提示语（RFC 3.6）

### 5.1 `src/core/format.ts` 的 `formatHeard()`

参数改成：

```ts
formatHeard(store, chat, messages, opts: { omitted?: number; live?: string[]; bursts?: { name: string; count: number }[] })
```

- **`live` 非空时**（这段走的是 fast 或 steer），第一行换成：

  > `[mingle] Heard in c12: 3 messages. You are in a conversation here with Li Lei: what he says is likely meant for you even without an @. Reply as you would in chat: if what you will do takes a moment, send a short line first, then one thought per message. Saying nothing is still fine if it was not for you.`

- **`bursts`**：一个人在这段里连发了 3 条以上时，加一句：

  > `Li Lei sent 4 messages in a row: answer them once, not each.`

- **慢通道**：原文不变（含 #168 的"前面还有 N 条"）。

### 5.2 `src/cli/manual.md` 的回复规则

在 "If what you are doing will take more than a moment, reply "on it" first" 后面加一条：

> In a direct chat, or in a group conversation you are part of, it is fine to answer in several short messages, one thought each, as the work goes. In a group you are only overhearing, keep it to one.

### 5.3 不做

- Mingle 不拆段。
- 不加新的 CLI 参数。

## 6. 档位与别名：存储、API、CLI、控制台

### 6.1 迁移 `031_hearing_v2.sql`

```sql
ALTER TABLE chats ADD COLUMN hear_tier TEXT;      -- NULL = 按活跃人数默认；'save' | 'balanced' | 'fast'
ALTER TABLE chats ADD COLUMN aliases TEXT;        -- JSON 数组，NULL = 没有
```

`Chat` 类型加 `hearTier: HearTier | null` 和 `aliases: string[]`。store 加：

- `setChatHearTier(id, tier | null)`；
- `setChatAliases(id, aliases)`；
- `activePeople(chatId, since): number`：这个群和它的线程里，`direction = 'in'` 的不同 `sender_id`，排除通讯录里标为机器人的人。

`Mingle` 按群缓存活跃人数 1 小时，再由 `defaultTier(n)` 决定默认档。

### 6.2 别名的约束

- 每个群最多 8 个，每个 2–20 个字符，去掉首尾空白后去重。
- Agent 和 owner 都可以加。别名只让叫它更容易被认出来，花费仍然受 owner 选的档位和每人的桶约束，不违背"只能调慢"。在 spec 里写明这一点。
- 关掉"听所有"时不清别名：别名是群的属性，不是节奏。

### 6.3 API（`src/api/server.ts`）

| 接口 | 改动 |
|---|---|
| `GET` 动态里每个群的 `hearing` | 加 `tier`（`null` 表示默认）、`defaultTier`、`live`（正在和谁聊，名字数组，最多 3 个）、`aliases` |
| `PUT /v1/admin/agents/:id/chats/:chatId/hearing` | **新增**，`{ "tier": "save" \| "balanced" \| "fast" \| null }`。现在这条路径上只有 `DELETE`（恢复默认节奏），两者不冲突 |
| `POST` / `DELETE /v1/admin/agents/:id/chats/:chatId/aliases` | **新增**，`{ "alias": "小跟班" }`，一次一个，在当前列表上改（原方案是整组替换的 `PUT`，会覆盖 Agent 刚加的名字，见第 14 节） |
| `POST` / `DELETE /v1/agent/chats/:id/aliases` | **新增**，`{ "alias": "小跟班" }`，给 CLI 用。线程按所属的群处理 |
| `GET /v1/agent/chats/:id`（`chat info`） | `hearing` 里带上 `tier` 和 `aliases` |

错误码：`alias_invalid`、`too_many_aliases`、`tier_invalid`。都在 `web/src/i18n.ts` 里给中英文文案。

### 6.4 CLI（先写进 spec 第 5.3 节）

```text
mingle chat alias <chat-id> add <name>       在这个群里，<name> 也算叫它
mingle chat alias <chat-id> remove <name>
```

- `chat info` 多两行：`pace: auto (fast, by size)` 和 `aliases: 小跟班, bot`。
- 档位不给 CLI：它是 owner 的旋钮，Agent 只能用 `--every` 调慢。

### 6.5 控制台（`web/src/AgentPage.tsx` 的 `ListenSwitch`）

按原型做。开关打开时，下面三行：

1. **档位**：省 / 均衡 / 快，用分段控件。下面一句写当前档的代价；用的是默认档时，加上"按群人数默认"。
2. **称呼**：Agent 名，不能删；后面是别名，原地添加和删除。复用现有的 chip 和输入样式，不新建组件。
3. **状态行**：三种，都写成文字：
   - `live` 非空："正在和李雷聊，他说完就接话"；
   - 慢下来："慢下来了"（`slowedMs`）；
   - 其他："在旁听"。

   原来的静音和 `--every` 说明，以及"恢复默认"，位置不变。

- i18n：新增 `listen.tier.*`、`listen.alias.*`、`listen.live`、`listen.overhearing`，中英文都加。
- `scripts/ui-review.mjs` 新增状态：三档各一，在聊（一人、三人）、旁听、慢下来、长别名、8 个别名、窄屏。

## 7. 日志（RFC 第 5 节）

`timeStretch` 的那一行扩成：

```text
alex: heard c12 fast: 3 messages from 1 person (2 engaged), first +0s, last +9s, handed over +14s, turn +15s, spoke +27s, last spoke +41s, cues 1
```

- `fast` / `steer` / `ride` / `slow`：这段走的哪条路。
- `last spoke`：这一轮里 Agent 在这个聊天里最后一次开口。store 新增 `lastSpokeBetween(chatId, from, to)`。
- `cues N`：这段里命中内容信号的条数。规则见下，只记日志、不影响节奏；`cuesIn(body)` 是纯函数：
  - 含第二人称（"你 / 您 / you"）且是问句（`?` / `？` / 吗 / 呢 结尾）；
  - 或者在 Agent 上一条发言后 60 秒内发出，并且没有回复别人。
- **触发路径**：runtime 新增依赖 `onTurnEnded?(messageIds)`。Mingle 对每条触发消息记一行 `alex: answered m8f2a in c12: first +6s, last +31s`，数据来自 store 里引用它的第一条和最后一条外发消息。

只写本机日志，不落库，不上报。

## 8. spec 和文档

- `docs/spec.md` 4.2：把"下一步：在聊时加快（已定，未实现）"改写成实际行为。"听多勤"一段补上档位和别名；5.3 加 `chat alias`；11.x 的进度表加一行。
- `DESIGN.md`：把"听群里所有的话"这一块的三行布局写进"最近活动"一节（原型已有）。
- RFC 0001 的状态改成"已接受，实现中"，实现合并后改成"已实现"。

## 9. 测试

| 文件 | 覆盖 |
|---|---|
| `test/hearing.test.ts`（新，纯逻辑、假时钟） | E 的衰减和打折；说完时间：μ+2σ、上下限、样本不足时的默认值；fast / ride / slow / steer 选路；`--every` 禁用快速通道；两层桶的扣减和补充；**上限性质**：随机生成 1 万条事件，断言任意窗口内白花的快速段 ≤ `C + T/r`；被晾减半让玩梗者两次后失效；`live` 只算有令牌、被晾少于 2 次的人；`nameIn` 的中英文和词边界 |
| `test/listen.test.ts`（已有，扩充） | 在聊的人 15 秒内交出，不受 2 分钟间隔约束；闲聊随下一段一起交，不单独开一轮；30 条先留在聊的人；`Heard` 在聊时的文案和"连发 N 条"；owner 设档位、恢复默认；别名命中后走快速通道；关掉"听所有"时清掉内存状态，但保留别名；`chat alias` 和 `chat info` 的输出、新接口和错误码（沿用这个文件里现有 `chat hear` 测试的写法） |
| `test/listen-steer.test.ts`（新） | 同一个人补充时插进去；别人的话不插；插在末尾没被处理时补交一次（预留令牌），第二次降级为 slow；插入后一轮又跑了 10 秒以上的不补交。单独一个文件：要用脚本化运行时卡住一轮，和 `listen.test.ts` 的 rig 写法不同 |
| `test/flow.test.ts`（已有，扩充） | runtime：带 `steer` 的 text 在运行中插进去，不带的照旧等下一轮；`handling()` 在 deliver 时设上，在 turn 结束时清空，queued 的不算 |
| `test/schema.test.ts` | 迁移 031；`activePeople` 排除机器人 |
| 模拟器对照 | **不做** `sim_impl.py`：用 Python 再写一遍规则，测的是两份手写代码是否一致，不是实现是否对。改为在 `test/hearing.test.ts` 里用同样的场景参数（1 对 1、30 人每分钟 6 条、玩梗刷名字）生成事件，断言 p90 和白花的量级（例如 30 人群 p90 < 90 秒、每小时白花 ≤ 档位上限），给实现一个和模拟可比的回归基线 |

`pnpm check` 全过，控制台改动跑 `pnpm build && pnpm ui:review`，逐张看截图。

## 10. 分几个 PR

| PR | 内容 | RFC 步骤 | 能不能单独发 |
|---|---|---|---|
| A | `hearing.ts` + `mingle.ts` 接线 + 30 条先留在聊的人 + 日志扩充 + 迁移 031 的 `hear_tier`（先只用默认档）+ spec 4.2 | 1 | 能：行为上就是 V2 的核心 |
| B | runtime 的 `steer` / `handling()` + 第 4 节 + 第 5 节提示语 + manual | 2、3 | 能，依赖 A |
| C | 别名（迁移里的 `aliases`、API、CLI、`nameIn` 接上别名）+ 档位 API + 控制台三行 + i18n + ui-review + DESIGN | 4 | 能，依赖 A |
| D | 发 minor 版本（v0.4.7）；官网文案、演示和截图、`llms.txt` | — | 发版后 |

A、B、C 都合并后一起发一个版本：A 单独发也安全，但发版节奏按"一个用户能感知的变化发一次"。

## 11. 风险

| 风险 | 应对 |
|---|---|
| 实际的打字节奏和模拟不一样，fast 把话切碎 | 日志里有 first / last / handed over，看"一段之后 10 秒内同一人又发"的比例。超过 20% 就把 `TURN_END.maxMs` 调到 15 秒 |
| 插入让 Agent 对同一个人连回两次 | 日志统计"同一人 10 秒内收到两条完整回复"。上升就把第 4 节限定为"只在这一轮还没开口时插" |
| 活跃人数的查询拖慢收消息 | 只在 `observe()` 时读缓存，过期了在后台刷新。需要的话给 `messages(chat_id, created_at)` 加索引；检查现有索引是否已经覆盖 |
| 别名被滥用（Agent 给自己加一堆常见词） | 限 8 个、至少 2 个字符；被晾减半照样生效；owner 在控制台能看到并删掉 |
| 重启丢掉在聊状态 | 和 V1 一样，只是第一段走慢通道。可以接受 |

## 12. CR 记录（DIYGod）

接口划分（第 2 节）、`mingle.ts` 只接线、分 4 个 PR 都同意。改了五处：

1. **令牌在交出时预留，开口了退回**（2.7）。原来"白花后才扣"在群和线程同时有几段在路上时会透支，上限公式不成立。
2. **人和全群的桶按群记，计时按聊天记**（2.2）。原来每人的桶记在聊天上，换到线程里就是一个新桶。
3. **不带引用的发言只算回了这一轮交给它的话里的在聊者**（2.6）。原来算"这个聊天所有在聊的人"，已经不说话的人会被一直拉回 E = 1。
4. **steer 本身不扣令牌，补交按 fast 预留**；只在插入后 10 秒内这一轮就结束时补交（4.2、2.7）。原来 steer 白花也扣令牌，但它没多花一轮；补交反而免费，成了绕开桶的口子。harness 只报 `steered`、不报"读到了"，所以用"插得太晚"近似"没读到"。
5. **测试**（第 9 节）：插入的集成测试单独成 `test/listen-steer.test.ts`；不做 `sim_impl.py`，改为在 `hearing.test.ts` 里用模拟器的场景参数做量级回归。

## 13. 实现时的偏差（PR B）

- runtime 的参数写成 `enqueueText(text, { track?, about?: { chatId, people }, steer?: boolean })`：`about` 是"这段里在聊的人"，旁听的每一段都带，`handling()` 靠它；`steer` 只决定插不插进去。比 4.1 的 `steer: { chatId, people }` 少一个"只带 people 不 steer"的特例。
- harness 回 `queued` 的旁听段，`track.ended` 等到它真正跑的那一轮结束才调，不在当前这一轮结束时调：否则还没被读到就按"没开口"结算了。
- steer 的一段等的时候有别人说话，整段改走 fast、在下一轮交，而不是只把那个人的话插进去：一段只有一种交法，`hear()` 不用拆段。


## 14. 实现时的偏差（PR C）

- **一段从它的第一条取，不再按 Agent 上次开口截掉**（3、`hear()`）。原来"只取它上次说话之后的"会把它回上一段时别人说的话丢掉：那句话在它开口前到，下一段交出时又在它开口之后，两头都没交给它。V1 的间隔长，很少碰到；快速通道下一句接一句，必然碰到。一段本来就从上一段交出之后开始等，被 @ 时整段作废，所以不会重复交。
- **交出时也重查每人的桶**（2.7）。原来只重查群的桶，同一个人在同一个群的几个线程里同时有快速段时，每段都扣他的令牌，扣成负数。现在没有令牌的人不算让它变快，一个都没有就改按默认节奏等。（麦哲伦 CR）
- **owner 改档位立刻同步到内存里的桶**（6.3）。原来要等这个群的下一条话才换档，已经在等的快速段按旧档位预留。现在 `setHearTier` 直接调 `HearingBook.setTier`，余额只收紧、不补满。（麦哲伦 CR）
- 别名每个最多 16 个字（第 6.2 节写的是 20）：控制台一行放得下，也不像一句话。
- 控制台的"在旁听"一行写的是默认节奏的 2 分钟：接口不给当前间隔，放慢时这一行换成原来的"最近几次都没开口"说明。
- **owner 增删别名改成一次一个**（6.3，麦哲伦复审）。整组替换时，控制台用轮询到的旧列表拼出新列表，会把 Agent 在两次轮询之间加的名字静默删掉。现在 owner 和 Agent 一样发 `POST` / `DELETE`，服务端在当时的列表上改。
- **交出时按当前的 `--every` 处理已经在排队的段**（2.7，麦哲伦复审）。原来只在计划时看 `--every`，排着的快速段照样走 fast、扣令牌。
- **控制台兼容旧主机**（6.5，麦哲伦复审）。SSH 主机上是 0.4.6 时 `hearing` 只有 `pace`，控制台按字段判断，只显示开关和节奏。
- 档位的说明不再写"每小时最多多用几轮"和"几十秒内接话"：3/6/12 是每小时补充的快速查看次数，还有起始余额，开口了会退还；回得多快取决于 harness 一轮，不是档位。
- **节奏变短时重排在等的段**（麦哲伦第三轮复审）。Agent 设 `--every` 后，在等的段按长间隔排了定时器；owner 恢复默认或改成更短的间隔时，原来只清掉退避，不重排定时器，没有新消息就要等满原来的长间隔。现在改节奏时，群和它的线程在等的慢段按新节奏重新定时（`HearingBook.retime`）。
- **静音后不补交插话**（麦哲伦第三轮复审）。插进正在跑的一轮之后 Agent 设了 `--mute`，这一轮很快结束又没开口时，原来仍会补交、开新的一轮。现在补交前和 `hear()` 交出前都检查群是不是静音或关掉了"听所有"。
