## 发布流程

版本号只有一个：`package.json` 的 `version`。桌面应用、更新清单和 Release 都用它。
推一个 `v<version>` 标签，`.github/workflows/release.yml` 就会构建并上传。标签的形式决定发什么。

| 标签 | 例子 | 构建 | 发布方式 | 已安装的应用 |
|---|---|---|---|---|
| 正式版 | `v0.2.0` | macOS（Apple 芯片、Intel）、Windows（x64、ARM64）、Linux（x64、ARM64） | 先进草稿 Release，维护者装一遍后手动发布 | 发布后自动更新到它 |
| 测试版 | `v0.2.0-beta.1`、`v0.2.0-rc.1` | 只有 macOS | 构建完自动发布为 Pre-release | 不会更新到它 |

想在不发版的情况下试一遍流水线，在 Actions 里手动运行 Release。它会构建全部平台但不上传，安装包作为构建产物保留。

### 发测试版

用来自己装上试，不打扰用户。

1. 把 `package.json` 的 `version` 改成 `0.2.0-beta.1`。
2. 在 `CHANGELOG.md` 加一节 `## 0.2.0-beta.1`，一两行说明测什么即可。流水线会检查这一节是否存在。
3. 提交，然后执行 `git tag v0.2.0-beta.1 && git push origin main v0.2.0-beta.1`。
4. 十几分钟后，Release 页面会出现这个 Pre-release，从里面下载 DMG 安装。

### 发正式版

1. 把 `version` 改成 `0.2.0`，在 `CHANGELOG.md` 写好 `## 0.2.0` 一节。这一节就是 Release 说明，也是应用更新窗口里显示的内容，写给用户看。
2. 提交，打 `v0.2.0` 标签并推送。
3. 等三个构建（macOS、Windows、Linux）都成功。任何一个失败，就在 Actions 里点 "Re-run failed jobs"，它会上传到同一个草稿。
4. 从草稿里下载本机对应的安装包，装上确认能启动、能打开控制台、已有的 Agent 和连接都在。
5. 发布草稿：执行 `gh release edit v0.2.0 --draft=false --latest`，或在网页上点 Publish。已安装的应用会在下次检查时收到更新。

发布后发现问题时，不要删除 Release：已安装的应用可能已经更新到它了。直接修复，然后发下一个补丁版本。

### 签名

没有证书时流水线照样能发，只是：

- macOS 应用是 ad hoc 签名。别的 Mac 首次打开会被拦住，需要到"系统设置 → 隐私与安全性"里点"仍要打开"。
- Windows 安装包没有签名，SmartScreen 会提示"Windows 已保护你的电脑"，需要点"更多信息 → 仍要运行"。

在仓库的 Settings → Secrets and variables → Actions 里加上下面这些 secret，流水线就会自动签名和公证。私钥和密码只放 secret，不要贴在 issue、聊天或提交里。

| Secret | 内容 |
|---|---|
| `MACOS_CERTIFICATE` | "Developer ID Application" 证书连同私钥，从钥匙串导出为 `.p12` 后做 base64：`base64 -i cert.p12 \| gh secret set MACOS_CERTIFICATE` |
| `MACOS_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设的密码 |
| `MACOS_SIGNING_IDENTITY` | 证书全名，如 `Developer ID Application: Jane Doe (TEAMID)`，用 `security find-identity -v -p codesigning` 查看 |
| `APPLE_ID` | 开发者账号的 Apple ID |
| `APPLE_TEAM_ID` | 团队 ID，即证书名括号里的那串 |
| `APPLE_APP_PASSWORD` | 在 account.apple.com 为这个 Apple ID 生成的 App 专用密码，公证用 |

Developer ID 证书需要加入付费的 Apple Developer Program（每年 99 美元）才能申请。装了 Xcode 但只用免费账号，只能拿到 "Apple Development" 证书，它不能用于对外分发。

`MYGO_UPDATER_PRIVATE_KEY` 是给自动更新签名的私钥，已经配置好。它决定谁能给所有已安装的 Mingle 推送更新：不要轮换，也不要外传。
