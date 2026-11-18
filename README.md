# Mingle

English · [中文](README_CN.md) · [mingle.build](https://mingle.build)

**Bring your agent companion into the chat apps you already use. Runs on your machine, no server.**

Create an agent on your own computer: it has a name, a role, a memory and a home directory, and it is driven by a coding agent you already use: Claude Code, Codex, Cursor, OpenCode, Kimi Code, Qwen Code, DeepSeek Harness and every other harness [OAR](https://github.com/botiverse/oar) drives. The agent joins WeChat, WeCom, Feishu, DingTalk, QQ, Slack, Discord and Telegram as a bot, answers @-mentions in GitHub issues and pull requests from an account of its own, and you can talk to it in iMessage on a Mac by texting yourself, where people can @-mention it, hand it tasks and hear back from it.

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

### Remote SSH (development)

In **New Agent → Run on → Add SSH host**, choose an alias read from local `~/.ssh/config`
(including common `Include` files), or enter an alias / `user@host` manually. Refresh reloads
the config without connecting. Enter a dedicated remote data directory, then choose
**Prepare and connect**. First log in
with `ssh` in a terminal so the host is trusted and key authentication works. Mingle uses
your system SSH client, config and ssh-agent; it does not store SSH passwords or keys.

The remote POSIX host needs Node.js 24+, npm and tar available to SSH, internet access
for the initial dependency install, and a supported, authenticated harness. `pnpm build`
produces the portable runtime archive automatically. Preparation installs that build in
the remote user's cache and starts an independent Mingle supervisor. It does not upgrade
an already-running remote instance.

If Node.js is missing, choose **Install remote environment → Install and connect**.
Mingle runs its bundled installer over SSH, shows progress and prepares the remote service
automatically. Failed jobs can be retried; repeated clicks reuse a running job. Keep local
Mingle running until setup completes. A manual command remains available as a fallback. The [GitHub-hosted script](https://github.com/gerayking/Mingle/blob/d0d35e92f3c8903690e47dff052e090572a9e088/scripts/install-remote.sh) installs Node.js 24 and npm in
`~/.local/share/mingle/node`, verifies the official SHA-256 checksum, and needs no sudo.
It supports Linux (glibc) and macOS on x64/arm64; curl (or wget when running the script
directly), tar, gzip and sha256sum/shasum must already be present. Mingle adds this private
runtime to PATH for SSH commands, so no shell profile changes or nvm initialization are
needed. Harness installation and sign-in remain separate. The installer can be rerun and does not replace a system Node.js.

Agents, chat connections, credentials and files live on that host (default data directory:
`~/.mingle-remote`). **Closing or disconnecting the local Mingle does not stop them.**
Reopen Mingle to manage the same Agents again. An unreachable SSH connection shows cached
state as unknown; it does not mean the Agent stopped. Remote folders must be opened on the
remote host; a copied handoff command must also run there, or use Paste content locally.

The host must stay powered and online, and allow detached user processes after SSH logout.
This version restarts a failed Mingle process but does not install remote boot startup.
After a host reboot, select that host in New Agent and choose **Prepare or reconnect**,
or configure your own system service. Remote service logs are in `ssh-service.log` inside
the remote data directory. Headless Linux follows the existing credential-store behavior:
Secret Service when available, otherwise a file restricted to the owning user (0600).

The SSH lifecycle is tested with an isolated Mingle process, scripted harness and fake
chat channel; real-host integration remains to be verified.

## Documentation

- [Product design and architecture](docs/spec.md) (Chinese)
- [Interface design](DESIGN.md) (Chinese)
- [AGENTS.md](AGENTS.md): working notes for coding agents (Chinese)

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

## Development

Requires Node.js 24 and pnpm.

```sh
pnpm install
pnpm check    # typecheck, lint, test
node scripts/remote-smoke.mjs  # after pnpm build: isolated remote archive smoke test
```
