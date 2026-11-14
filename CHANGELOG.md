# Changelog

Each version's section is its release notes, and what the update window shows.
Releases are cut as described in [docs/releasing.md](docs/releasing.md).

## 0.1.11

- Connect an agent's own GitHub account and mention it in issues, pull requests, or review threads. It replies in the original conversation and uses reactions to show progress. Only repository owners, members, and collaborators can trigger it; GitHub Discussions and file uploads are not supported. The default setup uses a classic token; signing in with a device code requires a configured OAuth client ID.
- Connecting a chat app now walks through one step at a time, with checks and a clear next action. On macOS, the iMessage guide checks access to Messages and explains which app needs each permission.
- Agents can see when a group conversation has unread background messages and read them before answering, without being interrupted by every message. Message history can be read from a known message onward, and search supports multiple words, quoted phrases, highlighted matches, and clearer guidance when results are incomplete.
- Reminders can refer back to the message that created them and be snoozed. Snoozing a recurring reminder moves its next occurrence without changing its schedule.
- Agents sharing the same harness sign-in now share usage-limit waits. Recovery resumes their waiting messages together, including after a restart; agents with their own credentials remain separate. Limits without a reset time are retried with backoff instead of failing immediately.
- Reconnecting the same bot through two simultaneous setup flows no longer creates duplicate connections. Asynchronous failures in greetings, timers, notifications, and recovery are caught and logged instead of bringing down the process.
- Message retries, duplicate platform message IDs, invalid API requests, and diagnostic logging handle failures more consistently. Runtime connection information is kept private on disk.
- An experimental option can rebuild context for a large session after a long idle period. It remains off by default while memory and answer quality are evaluated.

Known limitations: the GitHub machine-account notification and device-code sign-in flow still needs full end-to-end verification; current integration checks used a synthetic notification list. Connecting a second personal WeChat account still needs a real-device check.

## 0.1.10

- Messages now wait when the brain reports a usage limit with a reset time, and retry automatically after it. Temporary provider failures retry after 1, 5 and 15 minutes before asking you to intervene. Activity shows each waiting message's retry time, with Retry and Ignore controls. Quota waits survive a restart and also hold back new messages.
- Settings → Running now offers Reset session and Copy diagnostic info. Reset starts from the agent's role and memory while keeping its folder, messages, tasks, reminders and chat apps. Old background work loses permission to send, and diagnostic reports exclude message text, credentials and raw provider errors.
- Agents are reminded to trim MEMORY.md after completed work when it exceeds 64 KiB, at most once a day unless it grows another 25%.
- Message search shows excerpts around each match and a command to read the surrounding conversation: `mingle message read <chat> --around <message>`.
- Stopping an agent also stops its background work and blocks late replies. Slack file uploads work again, and a failed file upload no longer repeats text that was already sent.
- Slack apps created with the current manifest register `/stop` as a real slash command. In channels and threads, or with an older app manifest, use ` /stop` with a leading space.
- Cancelling agent deletion is explicit and returns keyboard focus to Delete; the new session reset confirmation follows the same behavior.

Known limitation: connecting a second personal WeChat account still needs a real-device check.

## 0.1.9

- On macOS, chat apps no longer go offline with "can't find this bot's credentials" after Mingle restarts. The Keychain kept only the first 128 characters of each bot's credentials (and of long environment variables), and returned names in other scripts in a form Mingle could not read. Credentials are now saved in full and checked when saved. Bots that already show this error need to be connected again once: scan or enter the credentials again for the same agent.
- One agent can be on several WeChat accounts, for example yours and a family member's: each scan adds its own connection and the ones already there stay connected. The scan page now says so. Scanning an account that is already connected here says it is already connected, instead of claiming it is bound to another bot.
- Agents now keep an address book. Every message header names the sender's contact (`user=u7k2p`), and an agent can name people with `mingle contact name` when the chat app gives no name, as personal WeChat never does. You can name each bot's owner from its row under Chat apps.
- Recent activity shows the names from that address book. An unnamed owner is shown as "You" only when it cannot be two people; with two owners on one platform each shows as "Unnamed" with its ID until named.
- iMessage on macOS now uses your own Apple ID: the agent replies in your self-chat and leaves your other conversations alone. Text, files, reminders and replies after restarting have been verified on a real Mac. Replies are not read back as new messages, and files are staged where Messages can send them reliably.
- Deleting an agent asks for confirmation in that agent's own row, so it stays clear which agent you are removing.
- On Slack, `/stop` now works: the app manifest registers it as a real slash command, which Slack delivers over Socket Mode instead of rejecting it client-side. Direct messages can send `/stop` as-is; in channels and threads, and for apps created before this version, send ` /stop` with a leading space.

Known issues: Slack file sending still needs a fix. A stopped background task may still send a late reply. Connecting a second personal WeChat account still needs a real-device check.

## 0.1.8

- Initial iMessage support on macOS: connect an Apple ID dedicated to your agent through the Mac's Messages app. Setup asks for your own phone number or email, Full Disk Access, and permission to control Messages. Private chats, group mentions and file transfers are implemented; real-account end-to-end verification is still pending.
- Settings, brain pickers, model lists and other slow-loading views show their last known data while refreshing, instead of waiting for each harness probe before showing anything. Installing or signing in refreshes the relevant lists.
- Recent activity, tasks and reminders distinguish loading, empty results and failures, with a retry action when a read fails. Switching agents keeps each agent's activity and work separate.
- The website has an interactive demo showing one agent across several chat apps, and its demo styles no longer affect other page sections.

## 0.1.7

- Pause an agent under Settings → Running (or `mingle agent pause`). A paused agent stops what it is doing and takes no messages until you resume it; people who write to it are told once per chat that it is paused, and reminders wait until it resumes. Its memory, settings and chat apps are kept, and it stays paused after a restart. "Stop" still only ends the current piece of work.
- Creating another agent now opens its "connect a chat app" step, instead of jumping to your first agent.
- Scanning an already connected bot again refreshes its credentials and reconnects it, so QQ's rotated secret no longer leaves the original connection offline. Scanning for the same agent succeeds; a bot already assigned to another agent stays with that agent.

## 0.1.6

- Each agent can have its own environment variables, such as a webhook address or an API key, under Settings → Environment variables. Values stay in the system credential store and cannot be read back, only replaced or deleted. The agent reads them in its shell; a change applies from its next message. Cursor cannot receive them, and the console says so.
- A chat app that cannot connect (for example, the network is not back yet after sleep) no longer stays offline for good: Mingle tries again by itself, waiting a little longer each time, and every bot that is offline has a "Reconnect" button. QQ no longer reports a network problem as revoked credentials.
- Only problems you have to fix yourself (refused credentials, missing permissions) stop the retries, and the console says what to do.
- Retrying a message while its bot is offline names that bot and says Mingle is reconnecting it; a retry with nothing left to do says so instead of claiming the chat app is offline. The message disappears after a few seconds.
- After removing an agent's last bot, the settings and the side panel still offer to connect one.
- The brain settings only explain the harness the agent uses; why another harness is not compatible shows on hover.
- Connection errors with an unrecognized cause show a message again instead of an empty box.
- Saving the role, removing a bot or an agent, and stopping now report a failure instead of leaving the button stuck.
- Desktop notifications treat a bot Mingle is retrying as disconnected (one notice after five minutes), not as a new failure on every attempt.
- Also includes the changes listed under 0.1.5, which was not published on its own.

## 0.1.5

- QQ no longer leaves a "正在思考 · 0 秒" message next to every answer: its streaming messages only ever showed their first frame, so QQ private chats now keep "typing…" on while the agent works and get the answer as a normal reply.
- Live progress replies on the other chat apps start as "Thinking…" and show the elapsed time from 3 seconds on, instead of opening with "0s".
- Messages the agent failed or did not answer can now be dismissed with "Ignore", next to "Retry" in the activity list and in "Needs you". An ignored message stays in the list but no longer counts as needing you or offers a retry.
- The chat-app picker shows how many bots an agent already has on each platform — "2 added" — and offers "Add another bot", instead of only "Added".

## 0.1.4

- A connection's "…" menu is no longer clipped by the card around it, and opens upward when there is no room below.
- "Manage" in the side panel scrolls to the chat apps section and puts it in focus, even when the settings tab is already open.
- The getting-started checklist keeps its last step done once the agent has sent its first reply — restarts, updates and removed connections no longer bring it back. Until then, "answering…" only shows while the chat app is connected and the agent is actually working; otherwise it says what to try next.
- Choosing light or dark by hand now looks identical to following the system, sidebar material included, and the desktop app's window controls follow the chosen mode.

## 0.1.3

- Settings open and brain changes save without the second-long wait: Mingle finds the installed harnesses once at startup, checks them side by side, and refreshes the list in the background.
- The console stops polling while its window is hidden, and catches up as soon as it is shown again.
- The agent list separates chat apps with commas in English and names each app once, even with several bots in it.
- The note under a pasted token no longer says "this Mac's Keychain" on Windows and Linux.

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
