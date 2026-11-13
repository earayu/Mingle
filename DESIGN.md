---
name: Mingle
reference: "Pinky (https://github.com/DIYgod/pinky): its palette, type ramp, spacing and step-by-step guides"
colors:
  light:
    bg: "#FFFFFF"        # the page
    bg2: "#F7F7F8"       # a quiet row, an answer in the activity list
    bg3: "#EFEFF2"       # hover, the segmented control's track
    sel: "#E7E7ED"       # the selected sidebar row
    line: "#EBEBEF"      # dividers, card borders
    line2: "#D9D9E0"     # control borders
    ink: "#1D1D22"
    ink2: "#5B5B64"
    ink3: "#8A8A93"
    accent: "#5450D6"    # the one brand color: primary buttons, the current step, focus
    accent-tint: "#F1F0FD"
    amber: "#975800"     # waits for someone, with amber-dot / amber-tint / amber-line
    red: "#C32C18"       # broke, with red-tint / red-line
    green: "#2F9E5A"     # works, done
    wing: "#F5F5F7"      # the sidebar and the right panel
    card: "#FFFFFF"
  dark:
    bg: "#1C1C1F"
    bg2: "#212125"
    bg3: "#2B2B30"
    sel: "#323238"
    line: "#2E2E34"
    line2: "#404047"
    ink: "#EDEDF2"
    ink2: "#B3B3BC"
    ink3: "#85858F"
    accent: "#9895FF"    # buttons use #5B57E0 behind white text
    accent-tint: "#262549"
    amber: "#F7A74E"
    red: "#F87A60"
    green: "#4CC38A"
    wing: "#212125"
    card: "#29292E"
typography:
  family-sans: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Helvetica Neue', sans-serif"
  family-mono: "ui-monospace, 'SF Mono', Menlo, monospace"
  caption: 12/16
  small: 13/18
  body: 14/20
  headline: 15/21 semibold
  title3: 17/24 semibold     # a page header
  title2: 20/28 semibold     # a page's own title
  title1: 26/34 bold         # welcome only
spacing: "a 4 pt grid: 4, 8, 12, 16, 20, 24, 32"
rounded: { small: 6px, control: 8px, card: 12px, sheet: 16px }
motion: { fast: 120ms, base: 180ms, easing: "cubic-bezier(0.2, 0, 0, 1)" }
---

# Mingle 界面设计规范

控制台的视觉和交互以本文为准，浏览器和桌面应用用同一套。产品和架构见 [`docs/spec.md`](docs/spec.md)。颜色、字号、间距、圆角都取自文件头，组件里不写色值（`web/src/styles.css` 是它的实现）。

参照 [Pinky](https://github.com/DIYgod/pinky)：简洁，但每一步都告诉人现在该做什么、Mingle 在等什么、卡在哪里。

## 原则

1. **一步一步带着走。** 第一次打开、新建 Agent、连接聊天软件、等它回复第一条消息，都是带编号的步骤：做完的打勾，当前这一步展开说明，后面的灰着。用户永远知道下一步是什么。
2. **能选的不让填。** harness 只列本机装了的；模型从 harness 实时读出来让人选；平台的 App ID、权限、名称能预填就预填。只有平台给的 token 需要粘贴。
3. **需要人的事放一处。** 出错的连接、等管理员审核、没回复的消息，都在"需要你处理"里，每条写清楚怎么办。
4. **像 Mac 应用。** 系统字体；侧栏是窗口的毛玻璃，红绿灯和品牌在同一行；设置是圆角分组的行；跟随系统明暗和语言。
5. **安静。** 没有弹窗、庆祝动画、引导气泡。状态就地变化。

## 颜色

- 一个品牌色 `accent`（靛蓝），只用于主按钮、当前步骤、选中、焦点和文字链接。
- 状态色：`green` 正常/完成，`amber` 在等人，`red` 坏了。提示框用对应的 tint 底和 line 边。
- 聊天软件和 harness 用它们自己的标识和品牌色，让人一眼认出（标识来自 Simple Icons 和 OAR；没有标识的用首字）。除此之外不加彩色。
- 跟随系统与手动选择相同明暗时，颜色和侧栏材质一致；桌面应用的原生外观同步跟随所选模式。

## 布局

- 三栏：左侧栏 220（Agent 列表、新建、设置），中间内容，右侧 320 的面板（需要你处理、聊天软件、任务、提醒）。窗口窄于 1140 时右侧面板并入中间，窄于 768 时侧栏收进抽屉。
- 页头 52 高，与侧栏的品牌行对齐，可以拖动窗口。左边是名字和状态，右边是"动态 / 设置"切换和"…"菜单。
- 内容单列，最大宽 680，左对齐。卡片 12 圆角、1px `line` 边。
- 第一次打开（还没有 Agent）时不显示侧栏，只有欢迎页和新建流程。

## 组件

- **按钮**：34 高（小号 28），8 圆角，中等字重。主按钮 `accent` 底白字，一屏最多一个；默认按钮白底 `line2` 边；危险按钮红字红边；幽灵按钮无边。
- **输入框**：34 高，`line2` 边，聚焦时 `accent` 边加浅色光圈。标签在上，`small`。
- **步骤**：24 圆圈。完成是绿底白勾，当前是 `accent` 描边数字，之后是灰边灰字。
- **分组**：设置类内容用圆角分组的行，左边说明，右边控件。
- **分段控件**：外观、语言、动态/设置这类二选一或三选一。
- **提示框**：图标 + 一句标题 + 一句怎么办，amber 或 red。
- **等待**：转圈 + 一句在等什么（"等待扫码，二维码 60 分钟内有效"）。

## 页面

- **欢迎**：图标、一句话、三个步骤（创建、连接、说话），一个"开始"按钮，一行隐私说明。
- **新建 Agent**：三步：起名字；写角色（可选，四个模板：私人助理、群聊帮手、编程搭档、翻译）；选大脑（本机 harness 卡片，带官方图标和版本；模型下拉，默认跟随 harness）。创建后直接进入"连接聊天软件"。
- **连接聊天软件**：先选平台（图标、名称、"用手机扫码"或"粘贴机器人 token"）。扫码类：二维码、"在这台电脑上打开"（平台支持时）、扫码后确认、等管理员审核，逐步推进。token 类：平台自己的几步说明，第一步带"打开开发者后台"按钮，最后一步是粘贴框。
- **Agent · 动态**：还没回复过消息时先显示"上手"四步卡片（已创建、连接、打招呼、收到回复），实时推进；是否回复过是 Agent 的永久标记，首次成功发出消息后卡片不再出现，不受最近活动条数、重启或移除连接影响，"正在回复"只在聊天软件已连接且 Agent 正在思考或工作时显示；然后是最近活动。右侧面板见布局。
- **Agent · 设置**：聊天软件、角色、大脑（harness 和模型都可改，下一条消息起生效）、文件夹和删除。
- **设置**：外观、语言、版本、隐私说明。

## 动效

- 淡入、轻微上移、展开，120–180ms。只用位移，不用透明度做入场（WebKit 在窗口不可见时会暂停动画，内容不能卡在不可见）。
- 尊重系统的"减少动态效果"。

## 文案

- 短句，陈述事实，不用感叹号。
- 按钮写动作：创建、连接、重试、删除。
- 出错时说明发生了什么和下一步，例如"凭据已失效。移除这个机器人后重新连接"。
- 不向用户暴露 session、inputId 这类内部词，也不显示内部错误码。
- 界面里称 Agent。"机器人"只指 IM 平台上的那个账号。
- 中文里中英文之间留一个空格（"连接到 Slack"，"连接到飞书"）。

## 国际化

- 所有文案走 `web/src/i18n.ts`，首批 `en` 和 `zh-CN`。
- 布局不依赖文案长度。日期、时间用系统区域格式。

## 无障碍

- 对比度不低于 4.5:1；状态除颜色外必有文字。
- 所有操作可用键盘完成，焦点可见（`accent` 2px）。
- 可点击区域不小于 28px。

## 不要

- 不要模态弹窗；删除这类确认在原地展开。
- 不要仪表盘、图表、统计数字。
- 不要在控制台里做聊天界面。对话发生在 IM 里。
- 不要让用户填能自动得到的东西。
