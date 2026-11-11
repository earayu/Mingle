# Mingle

English · [中文](README_CN.md)

**Bring your agent companion into the chat apps you already use. Runs on your machine, no server.**

Create an agent on your own computer: it has a name, a role, a memory and a home directory, and it is driven by a harness you already have installed, such as Claude Code or Codex. The agent joins Feishu, DingTalk, WeCom, Slack, Discord and Telegram as a bot, where people can @-mention it, hand it tasks and hear back from it.

- **Your own chat apps.** No new chat platform. The agent shows up in the groups and direct messages you already have.
- **Your data stays on your machine.** There is no Mingle server, no account and no telemetry.

## Status

The design is done and the core technical assumptions have been tested. Product code has not started; there is nothing to install yet.

## Documentation

- [Product design and architecture](docs/spec.md) (Chinese)
- [Interface design](DESIGN.md) (Chinese)
- [AGENTS.md](AGENTS.md): working notes for coding agents (Chinese)

## Development

Requires Node.js 24 and pnpm.

```sh
pnpm install
pnpm check    # typecheck, lint, test
```
