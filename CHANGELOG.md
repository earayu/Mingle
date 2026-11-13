# Changelog

Each version's section is its release notes, and what the update window shows.
Releases are cut as described in [docs/releasing.md](docs/releasing.md).

## Unreleased

- When the agent can't answer (its harness is signed out, out of usage, unpaid, busy, or not installed), the person in the chat is told what happened and what helps, instead of the reply staying on "Thinking". Chat apps without live replies get a short message.
- The console says the same in plain words, with the next step, and no longer shows "answering…" for a message that failed.
- The desktop app picks up the environment from your login shell, not just PATH: an API key, base URL or proxy you set for Claude Code or Codex in `~/.zshrc` now works when Mingle is opened from Finder too.
- "Not signed in" now also says how to use an API key instead, for Claude Code and Codex, with a link to their docs.
- Retry a message the agent failed or did not answer, from "Needs you" or next to the message in the activity list. The agent answers in the chat and knows the answer is late.

## 0.1.0

The first release.

- Agent companions driven by the Claude Code or Codex already on your computer, one long-lived session each, managed from the desktop app, a local web console or the `mingle` command.
- Eight chat apps: Feishu, WeChat, WeCom, DingTalk, QQ, Telegram, Slack and Discord. Most connect by scanning a code; the rest by pasting a token.
- Replies show work as it happens: a reaction on the message, then a live reply or card that turns into the answer.
- Files go both ways on every chat app.
- Desktop apps for macOS, Windows and Linux, which keep Mingle running and update themselves.
- Credentials stay in the system's store: the macOS Keychain, Windows DPAPI, or the Linux Secret Service.

Known limits: the apps are not signed with a Developer ID or a Windows certificate yet, so macOS asks you to allow the app in System Settings → Privacy & Security, and Windows SmartScreen warns before the installer runs. Only Feishu has been verified on a real tenant; the other chat apps are verified against their APIs.
