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
3. 等三个构建（macOS、Windows、Linux）、smoke 和 verify 全绿。构建是串行上传的（见下文），任何一个失败就在 Actions 里点 "Re-run failed jobs"，它会上传到同一个草稿。verify 作业会下载草稿里的全部资产，校验大小、SHA256SUMS，以及更新清单中记录的更新包／增量包 Ed25519 签名——它不绿就不要发布。
4. 从草稿里下载本机对应的安装包，装到一台已经装着旧版、已有 Agent 和连接的机器上，确认装完能启动、能打开控制台、数据都在。注意这只验证"新安装包覆盖旧数据"，不等于验证了自动更新链路；真正的更新验收还要另做：让一台装着旧版正式版的机器自己检查更新，确认它能下载、验签、重启到新版本且数据无损（发布新版时按此补一次实测）。
5. 发布草稿：执行 `gh release edit v0.2.0 --draft=false --latest`，或在网页上点 Publish。已安装的应用会在下次检查时收到更新。不要在 release 工作流还在跑的时候发布它的草稿——检查只挡住"发布后再 rerun"，并不保证构建中途发布是原子的。
6. 发布会触发 website 工作流重建并部署官网（`mingle.build` 的下载链接指向刚发布的版本）。如果同步失败或需要重放，执行 `gh workflow run website.yml --ref main`。

发布后发现问题时，不要删除 Release：已安装的应用可能已经更新到它了。直接修复，然后发下一个补丁版本。

### 发布的安全边界

- **上传串行化**。三个平台的构建共用同一份 `SHA256SUMS` 和安装脚本，`mygo -upload` 会合并后以 `--clobber` 覆盖，所以构建矩阵用 `max-parallel: 1` 串行上传，避免并发写互相截断。
- **正式版必须签名**。正式标签（非 pre-release）的 macOS 构建要求全部六个签名 secret 就位，缺失就直接失败，不会退回 ad hoc 签名；构建后还会对 DMG 跑 `codesign --verify`、`spctl --assess` 和 `stapler validate`。测试版和手动构建仍允许 ad hoc。
- **已发布的 Release 不可变**。plan 阶段和每个构建开始前各查一次 `isDraft`：已经发布后 rerun 会直接失败，而不是改动发出去的字节。整个 workflow 按 tag 加了 concurrency，同一个 tag 不会有两个并发 run。注意这不是原子保证：构建期间有人手动发布会绕过检查，所以不要在工作流运行中发布它的草稿。
- **更新签名要私钥**。任何带标签的构建都要求 `MYGO_UPDATER_PRIVATE_KEY`，它签的是更新清单里记录的更新包和增量包；没有它就不存在有效的清单可上传。
- **网站只认已发布的 Latest**。website 工作流对 draft 和 prerelease 事件直接跳过；未来若由其他工作流（如用 `GITHUB_TOKEN` 发布正式版）触发，注意 `GITHUB_TOKEN` 产生的事件不会再级联触发工作流，必须用 `workflow_call` 显式调用 website 工作流（它声明了两个 Cloudflare secret）。

### 回滚

如果已发布版本有问题：把上一个好版本重新设为 Latest（`gh release edit v<旧版> --latest`），再手动跑一次 `gh workflow run website.yml --ref main` 让官网指回去。这只能阻止后续的新下载和新更新提示——已经提示或已经更新到新版的安装无法撤回，修复要以前向的新版本发出；涉及数据库迁移的修复要特别注意向后兼容。

### 签名

测试版和手动构建没有证书时流水线照样能跑（正式标签会直接失败，见上文），只是：

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
