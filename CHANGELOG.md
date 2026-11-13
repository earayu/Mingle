# Changelog

Each version's section is its release notes, and what the update window shows.
Releases are cut as described in [docs/releasing.md](docs/releasing.md).

## Unreleased

- Settings open and brain changes save without the second-long wait: Mingle finds the installed harnesses once at startup, checks them side by side, and refreshes the list in the background.
- The console stops polling while its window is hidden, and catches up as soon as it is shown again.

## 0.1.2

- The menu bar icon (the notification area icon on Windows) shows each agent and what it is doing, lists what needs you, and shows a dot when something does. Click an agent to open its page. On Windows, a click opens the window and a right click opens the menu.
- Quitting asks first while agents are online, since they stop answering until Mingle opens again.
- "Keep your agents online": once an agent is connected, the console offers to open Mingle at login and to keep the computer awake while it is plugged in. Both are also in Settings and in the menu bar menu.
- After the computer wakes from sleep, Mingle reconnects every chat app at once instead of waiting for each connection to notice it died, and fires the reminders that came due.
- Notifications when something needs you: a connection fails or stays down for five minutes, an admin approves a bot, or an agent could not answer. They can be turned off in Settings.
- Follow the system language by default, remember an explicit language choice, and allow switching back to the system language in Settings.

## 0.1.1

- Check compatibility before an agent starts, with clear explanations for unavailable harnesses. OpenCode 1.x remains supported; OpenCode 2.x and unrecognized versions cannot be selected.
- Open the agent's session before the first chat message, so startup problems appear sooner without sending a model input. Existing agent data and messages are preserved; failed messages can be retried after recovery.

- When the agent can't answer (its harness is signed out, out of usage, unpaid, busy, or not installed), the person in the chat is told what happened and what helps, instead of the reply staying on "Thinking". Chat apps without live replies get a short message.
- The console says the same in plain words, with the next step, and no longer shows "answering…" for a message that failed.
- The desktop app picks up the environment from your login shell, not just PATH: an API key, base URL or proxy you set for Claude Code or Codex in `~/.zshrc` now works when Mingle is opened from Finder too.
- "Not signed in" now also says how to use an API key instead, for Claude Code and Codex, with a link to their docs.
- Retry a message the agent failed or did not answer, from "Needs you" or next to the message in the activity list. The agent answers in the chat and knows the answer is late.
- The desktop app downloads updates in the background and installs them on its own. When one is ready, "Restart to update" shows at the bottom of the sidebar; Settings shows the update status, checks for updates, and turns automatic downloads off.

## 0.1.0

The first release.

- Agent companions driven by the Claude Code or Codex already on your computer, one long-lived session each, managed from the desktop app, a local web console or the `mingle` command.
- Eight chat apps: Feishu, WeChat, WeCom, DingTalk, QQ, Telegram, Slack and Discord. Most connect by scanning a code; the rest by pasting a token.
- Replies show work as it happens: a reaction on the message, then a live reply or card that turns into the answer.
- Files go both ways on every chat app.
- Desktop apps for macOS, Windows and Linux, which keep Mingle running and update themselves.
- Credentials stay in the system's store: the macOS Keychain, Windows DPAPI, or the Linux Secret Service.

Known limits: the apps are not signed with a Developer ID or a Windows certificate yet, so macOS asks you to allow the app in System Settings → Privacy & Security, and Windows SmartScreen warns before the installer runs. Only Feishu has been verified on a real tenant; the other chat apps are verified against their APIs.
