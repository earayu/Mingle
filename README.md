# Mingle

English · [中文](README_CN.md) · [mingle.build](https://mingle.build)

**Bring your agent companion into the chat apps you already use. Runs on your machine, no server.**

Create an agent on your own computer: it has a name, a role, a memory and a home directory, and it is driven by a coding agent you already use: Claude Code, Codex, Cursor, OpenCode, Kimi Code, Qwen Code, DeepSeek Harness and every other harness [OAR](https://github.com/botiverse/oar) drives. The agent joins WeChat, WeCom, Feishu, DingTalk, QQ, Slack, Discord and Telegram as a bot, where people can @-mention it, hand it tasks and hear back from it.

- **One agent, every chat app, one memory.** Like a person, the same agent is in your Feishu work group, your WeChat family chat and your Discord server at once, and remembers all of it. Ask it in WeChat what the team decided in Feishu this morning, or have it pass a message from Slack to Telegram.
- **Your own chat apps.** No new chat platform. The agent shows up in the groups and direct messages you already have.
- **The agent you already pay for.** It runs on the harness and subscription you have; Mingle adds no model and no bill.
- **Your data stays on your machine.** There is no Mingle server, no account and no telemetry.

## Status

Early development. The core works end to end with Claude Code, Codex, OpenCode and Kimi Code, managed from a local web console, the desktop app or the command line. Missing harnesses can be installed and signed in from the app. All eight chat apps are built; Feishu is verified on a real tenant, the others against their APIs and in tests.

Download the desktop app for macOS, Windows or Linux from [Releases](https://github.com/earayu/Mingle/releases/latest). The macOS app is signed and notarized by Apple. The Windows app is not signed yet: choose "More info → Run anyway".

```sh
pnpm install && pnpm build
node dist/cli/main.js start                       # keep this running
node dist/cli/main.js agent create --name Alex --harness claude --role "You help me plan trips."
echo "$TELEGRAM_BOT_TOKEN" | node dist/cli/main.js connect alex telegram
```

`mingle start` opens the console in your browser; `mingle open` opens it again later. Send the bot a direct message from your own Telegram account; that makes you its owner.

### Desktop app

The desktop app wraps the same console in a window and a menu bar icon, ships its own Node.js, keeps Mingle running in the background, and can open at login and update itself. Build it locally (needs Go; the right version downloads itself):

```sh
pnpm desktop:build      # this machine's app, e.g. desktop/build/darwin-arm64/Mingle.app and a .dmg
```

Releases are built by GitHub Actions for every platform; see [docs/releasing.md](docs/releasing.md).

## Documentation

- [Product design and architecture](docs/spec.md) (Chinese)
- [Interface design](DESIGN.md) (Chinese)
- [AGENTS.md](AGENTS.md): working notes for coding agents (Chinese)

## License

[MIT](LICENSE)

## Development

Requires Node.js 24 and pnpm.

```sh
pnpm install
pnpm check    # typecheck, lint, test
```
