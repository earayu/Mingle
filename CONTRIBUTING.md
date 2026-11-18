# Contributing to Mingle

Thanks for wanting to help. Bug reports, fixes, new harness or chat app testing, docs and translations are all welcome.

## Reporting bugs and ideas

Open an [issue](https://github.com/earayu/Mingle/issues/new/choose). For bugs, say which version, operating system, harness and chat app you use, and attach the relevant lines of `~/.mingle/logs/mingle.log` with tokens and private messages removed. Issues in Chinese or English are both fine.

Security problems go to a [private advisory](https://github.com/earayu/Mingle/security/advisories/new) instead; see [SECURITY.md](SECURITY.md).

## Before you write code

For anything larger than a small fix, open an issue first so we can agree on the approach. Mingle has a few constraints it doesn't bend on:

- **No server.** No cloud component, account, telemetry or outbound reporting. The local API only listens on `127.0.0.1`.
- **Mingle doesn't run its own agent loop.** Models and tools belong to the harness, reached through [OAR](https://github.com/botiverse/oar).
- **Secrets stay in the system keychain**, never in the database, logs or API responses.

[`docs/spec.md`](docs/spec.md) is the source of truth for scope and architecture, and [`DESIGN.md`](DESIGN.md) for the interface (both in Chinese). [`AGENTS.md`](AGENTS.md) has the code map and working rules; it is written for coding agents but is the quickest tour for people too.

## Development

Requires Node.js 24 and pnpm.

```sh
pnpm install
pnpm build
MINGLE_HOME=/tmp/mingle-dev node dist/cli/main.js start   # a throwaway home, separate from your real agents
pnpm dev:web                                              # console with hot reload, proxied to the running instance
```

## Pull requests

- Keep one pull request to one change, and include tests for behavior changes.
- `pnpm check` (typecheck, lint, tests) must pass. `pnpm format` fixes formatting.
- If you change the console, run `pnpm ui:review` and look through the screenshots: no clipped or overflowing text, and every string in both English and Chinese (`web/src/i18n.ts`).
- Write code, comments and commit messages in English. Commit messages are imperative and say what changed and why.
- Never commit credentials, tokens or personal data.

By contributing you agree that your work is released under the [MIT License](LICENSE).
