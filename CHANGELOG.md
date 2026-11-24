# Changelog

Each version's section is its release notes, and what the update window shows.
Releases are cut as described in [docs/releasing.md](docs/releasing.md).

## 0.4.10

- Tasks and reminders in the work panel now show status dots, the last checked time for check reminders, and inline error details when a check fails.
- The console feels snappier and uses less background polling: typing in Chat no longer re-renders the message list, pages prefetch as you move to them, and unchanged views skip redundant work.
- Fixed Grok agents closing a parallel task early while a background command or monitor is still running, so the task stays open until the result comes back.
- Fixed several bugs across threads, private chat, remote SSH, and group conversations: long-task threads now open reliably on Feishu and Discord, remote SSH agents preserve filenames and raw bytes for private chat uploads and downloads (including JSON and binary files), Chat pagination no longer breaks around notices, and Markdown code fences with extended language tags or nested backticks render cleanly.

## 0.4.9

- Chat with your agent right in the Mingle app: open its new Chat tab. It is the same agent with the same memory as in your chat apps, and it works before any chat app is connected. Replies render with formatting, and files go both ways: drop, paste or attach them, and open what the agent sends in Finder.
- When an agent writes to you there while you are elsewhere (a reminder, a finished task), the sidebar marks it and the desktop app sends a notification that opens the chat.

## 0.4.8

- Fixed messages that arrived while your agent was still working on a reply sometimes being lost after the agent restarted. They now stay queued and reach it once it is back.

## 0.4.7

- In groups where your agent hears everything, it now keeps up with a conversation: once someone is talking with it, what they say next reaches it as soon as they finish, without an @mention and without the old two-minute wait. Other chatter still waits for it at the usual pace.
- Calling the agent by name in a group counts as calling it. Add other names the group uses for it (like a nickname) in the console under the group, or let the agent add them itself.
- Choose how quickly the agent keeps up in each group: Save, Balanced or Fast. Small groups start on Fast, busier ones on Balanced. It only spends more when it looks and has nothing to say.
- A message someone adds while the agent is still working on their request goes straight into that work, and the agent is nudged to reply in short messages, starting with a quick line before longer work.
- Fixed messages sent while the agent was replying in a group sometimes never reaching it.

## 0.4.6

- On Feishu, Slack, and Discord, your agent can keep a long task's questions and progress in a thread. Reply there without another @mention to add details or ask it to stop. The result comes back to the group chat.
- The agent's task list shows the latest progress even on chat apps without threads. Closing a task now stops the work, and the same message no longer starts duplicate tasks.
- Long tasks start with the request and the messages just before it, so the agent can pick up the context without asking you to repeat it.

## 0.4.5

- Your agent now hears what is said in the groups it is allowed in — including groups it was already in — wherever the chat app delivers those messages, not only when someone @-mentions it. You can turn this off for any conversation.
- Busy groups taper off on their own: when the agent has nothing to add, it hears from the group less and less often. The agent can also choose to hear a group at most once a week, or stay out of ordinary chatter until someone speaks to it directly.

## 0.4.4

- @mention your agent in a Feishu document comment and it can answer in the same thread. For an existing bot, open its Feishu permissions and scan again to enable Document comments.
- On Windows, Mingle now clears stale web caches after an update to prevent a blank window, without clearing cookies, local storage, or preferences.

## 0.4.3

- Making a new agent when you already have one? The New agent page now reminds you that one agent can join all your chat apps and work on several things at once. If you have exactly one agent, it links straight to connecting it to another chat app.

## 0.4.2

- Agents hand off code changes, investigations, and long commands more reliably, so they stay available to answer chat messages while the work runs.
- Fixed a case where a parallel task could get stuck after Claude Code moved a long command into the background. The task now stays open so Claude Code can finish and reply.

## 0.4.1

- An agent can now do several things at once. When something will take a while — writing code, longer research, long commands — it starts that work on the side and stays free to answer everyone else. When the work is done, the agent answers under the message that asked for it.
- Replying to that answer, or writing in the same thread, goes straight back to the same piece of work, even days later. Nothing to set up: up to three things run at once, and the rest wait their turn.
- See what your agent is doing in the activity: each piece of work shows where it came from, how long it has been running, and its result when done. Stop one there, or everything with Stop or `/stop`.
- Teams are gone. Agents that were members are now agents of their own and keep their chat apps; unfinished work given to them goes back to the agent that gave it.
- Work that a restart of Mingle interrupted now carries on by itself.

## 0.4.0

- An agent can lead a team. In an agent's Settings → Team, add other agents on this computer as members, or create a new agent straight into the team. The lead keeps talking with people and stays quick to answer; work that takes a while — writing code, longer research, long commands — goes to a member with `mingle task create --to`, and the lead reports the result back in the original chat. Members don't need a chat app of their own.
- The lead and each member share a private chat that never leaves your computer. It shows in the activity with a team mark, and the sidebar shows members under their lead. One level, one team per agent, and only you can change who is in a team.
- If two agents go back and forth 20 times with no person speaking, Mingle pauses their chat and asks you in "Needs you"; one click lets them go on. Nothing they sent is lost, even across a restart.
- Once a day, an idle agent gets a quiet turn to tidy its memory: it brings `MEMORY.md` and `notes/` up to date, marks finished work finished and drops what is out of date, without sending anything to chats. Turn it off in Settings → Running.

## 0.3.3

- Mingle can now use Devin and Factory Droid to run your agents. Install and sign in to either CLI on the machine where your agent runs, then choose it as the agent's brain in Mingle.

## 0.3.2

- Ask your agent to watch a pull request's checks, a page, or a new release. Mingle runs the check on your machine without using model quota for each poll. A change wakes the agent, and a check that's no longer needed can be cancelled from the console.
- Checks stop when cancelled and respect their deadline even when snoozed. Check commands no longer inherit the agent's configured credentials, and raw check output is no longer kept in reminder history.
- Long-running chat replies finish more reliably. Feishu keeps updating the original card where possible; when a platform's live reply window closes, Mingle can send the answer as a new message.
- If a harness refuses to resume a saved session, Mingle can start a fresh session instead of getting stuck on the same error.

## 0.3.1

- An agent can hand a conversation to another agent in a group: when its answer names someone as `@name` — a person, a bot, or the platform name — Mingle writes the platform's real mention on Feishu, Slack, Discord, Telegram and GitHub, so the other side is actually woken. Mentioning two agents together now gets them talking to each other. After `reply`/`send`, the agent sees who was mentioned and which @words matched nobody, and two agents mentioned together learn each other's name.
- A group can listen to everything: a "Hear every message here" switch on the conversation in the activity makes the bot take in all messages where the chat app sends them (Feishu, Slack, Discord, Telegram). What people say is gathered into one input after a stretch of quiet — no live reply and nothing marked unanswered; the agent speaks up only when it has something to add, and an @ still reaches it at once.
- Threads keep listening without an @: once the agent has spoken in a Discord thread, what people say next wakes it, as Slack threads already did.
- A reply now says what it answers: the agent sees `> name: …` above the reply text (clipped to 200 characters), so a bare "approved" makes sense without reading back.
- Mingle's own lines — a new bot's greeting to its owner, the "let me check with my owner" answer to a stranger, claim confirmations — are kept with their chat and shown in the activity instead of going unrecorded.

## 0.3.0

- An agent no longer stays "working" forever on a command that never ends. When a turn reports nothing at all — no thinking, text, tool call, subagent or background-task update, and no `mingle` command from the agent — for twenty minutes while a message is waiting on it, Mingle stops the turn on its own rather than counting it an owner stop: the harness gets thirty seconds to end it before its process is replaced and the conversation continues in a new one. Messages sent while it was stuck are then answered in a fresh turn, or shown as "No reply yet", instead of disappearing into the stuck turn — the status no longer sits on a tool name and the owner no longer has to reset the agent by hand.
- A long job the agent took on after acknowledging a message is left alone: a quiet turn nobody is waiting on is not stopped. Mingle checks it again every minute and steps in only once a new message arrives and goes unanswered.

## 0.2.4

- An agent no longer stays "working" forever on a command that never ends. When a turn reports nothing at all — no thinking, text, tool call, subagent or background-task update — for twenty minutes, Mingle stops the turn on its own rather than counting it an owner stop: the harness gets thirty seconds to end it before its process is replaced and the conversation continues in a new one. Messages sent while it was stuck are then answered in a fresh turn, or shown as "No reply yet", instead of disappearing into the stuck turn — the status no longer sits on a tool name and the owner no longer has to reset the agent by hand.

## 0.2.3

- A message is no longer written off a second after it was sent when the agent's harness acknowledged it without running it. Kimi Code answers a prompt queued behind its own background task instantly with an empty turn, and Mingle used to take that as the agent staying silent — it reminded once, got the same instant empty answer, and marked the message unanswered, all before the model ever saw it. Such a turn now counts as no turn at all: the message waits for the turn that really runs it, is checked again after ten minutes or the next real turn, and the agent's late answer still settles it. A message a harness without steer queued for its next turn is likewise not reminded about until a turn has run on it.
- "This message did not get a reply" no longer appears when the agent did answer — by quoting another message in the same chat, or by answering after the reminder was already queued. The line now reads "No reply yet." so it stays true when a late answer arrives, and the reminder is re-checked at delivery so the agent never sees one for messages it already answered.

## 0.2.2

- The activity on an agent's page is now grouped by conversation instead of one timeline. Each chat gets a row, newest first; a closed row shows the last question and the agent's answer, and opening it reads the latest six messages in place with a link for earlier ones — the newest conversation starts open, and ↑↓ / → / ← move, open and close rows like a Mac list. Threads a platform attaches to a channel (Slack today) nest under that channel. What still needs you — messages that failed, went unanswered or wait for your approval — is marked right on the row and comes back however old, so a busy group can no longer push an unanswered request out of view. Discord threads and Telegram topics still show as their own rows for now.
- A bot's permission page can turn everything on with one scan. When more than one permission is off, a "Turn all on" action grants them all at once instead of scanning once per row. The two group-message permissions are also named by sender — what people send vs. what other bots send — so the pair no longer looks redundant.
- Agents are now told plainly to talk only through Mingle: a chat app's own CLI, MCP server or skill must not be used to send, reply or react, even when it offers to. Two Feishu agents had written to colleagues through a CLI signed in as a different real account, so people heard that account rather than the agents.

## 0.2.1

- Two Feishu bots in one group both hear a message that @-mentions them now. The Feishu SDK skipped a message ID it had already delivered, and all bots in one process shared that check — so when a person @-ed two agents at once, only the first to see it got the message and the other stayed silent. Each connection now keeps its own duplicate check. Verified on a real Feishu group: eight messages @-ing one or both bots all reached the right agent.
- Feishu agents can see what other bots say in their groups. Feishu never pushed another bot's messages before; the bot's app now asks for that when it is created, and a bot connected earlier can add it from the Permissions section on its page — one re-scan of the same code brings the grant onto the existing app. Other bots' messages arrive as background, marked as bots, so they never wake the agent unless they explicitly @ it, and the existing five-reply brake between bots still applies.
- Agents remember the bots in their groups, not only the people. Feishu's member list leaves bots out, so the agent also reads the group's bot list — other agents and bots appear in `contact list` and `chat info` with a `bot` mark, ready to be @-ed. The owner's contacts page no longer fills up with a large group's member list: it shows people who wrote to the agent or were decided about, while the full roster stays in the agent's own address book.
- A bot's page can show where someone sits in the organization. The Permissions section is now a row per permission — what it gives the agent, and either "On" or a button to turn it on in place. On Feishu, "Member profiles" asks for department and title only (never email or phone); once on, a person's line such as "Product · Product manager" shows in the agent's first greeting card, `contact list`, and the console.
- An agent can message a person directly even before that person has ever written to it.

## 0.2.0

- Agents can now run on your own SSH host, not only on this computer. Until now an agent stopped receiving and replying the moment this computer slept or Mingle quit, because everything — its harness, chat connections, credentials, data and reminders — lived here. A remote agent keeps all of that on your host: it stays online and keeps working while this computer is off, and the console manages it over SSH. This computer stays the default run location, and there is still no hosted service — both sides only listen on loopback.
- Choosing a remote host is part of picking the agent's brain: in the "choose its brain" step, the words "this computer" open a menu listing hosts from your `~/.ssh/config` and an "Add SSH host…" option that expands right there. Mingle then installs a private Node.js runtime and its own service on the host for you — one click, with progress and retry when something fails. While a host is being prepared the location can't be switched, and when a remote agent's host is unreachable — after a reboot, for example — its own page offers "Prepare or reconnect" in place. The agent's header and its Brain settings show which host it runs on. A run location can't be changed after the agent is created.
- Shortcuts are easier to discover. Buttons with a shortcut now show a small tooltip with its key after a short hover — instantly when moving between buttons — and holding the modifier alone (⌘ on Mac, Ctrl elsewhere) for half a second reveals every shortcut beside its button, the way Windows shows access keys while Alt is held. The agent page gains ⇧⌘[ and ⇧⌘] (Ctrl+Page Up / Ctrl+Page Down, or Ctrl+Tab) to switch tabs and ⌘. to stop a reply.

## 0.1.19

- An installed agent app no longer flickers between "installed" and "not installed". Checking whether a harness such as CodeBuddy is installed launches several probes at once — especially slow on Windows, where each probe starts a `.cmd` shim and Node — and a single timed-out probe used to replace the earlier answer, so the harness picker and the install status in Settings could lose a working harness. Mingle now remembers where each harness was last found, keeps it while the program is still on disk, and only reports "not installed" when the program ran and refused or its file is gone. The picker and Settings also share one probe instead of running their own at the same time, and starting a session trusts the remembered copy, so one missed probe can no longer fail with "not installed".

## 0.1.18

- The console and the desktop app answer the keys each platform already uses — Command on macOS, Ctrl on Windows and Linux. ⌘N / Ctrl+N starts a new agent, ⌘, / Ctrl+, opens settings, and ⌘1–⌘9 / Ctrl+1–9 jumps to that agent in the sidebar. In the app, ⌘[ and ⌘] (Alt+← and Alt+→ on Windows and Linux) go back and forward, ⌘W / Ctrl+W closes the window while Mingle keeps running, and ⌘Q / Ctrl+Q quits, asking first while agents are online. Esc backs out of every in-place question and editor, and ⌘Return / Ctrl+Enter submits a multi-line field. The Mac app gains the standard menu bar — Settings, File, Edit, View and Window — and sidebar buttons show their shortcut on hover.
- Naming a new agent is quicker: a dice button in the name field suggests a companion name, skipping names your other agents already have, and two role templates join the list — Study buddy and Habit coach, in English and Chinese.
- The sidebar's brand row drops the logo mark; the wordmark stays and still drags the window.

## 0.1.17

- iMessage keeps the agent in one thread. Every message to yourself is stored twice, once per address, and the agent used to answer in whichever copy Messages wrote first, so its replies jumped between your email and phone-number threads and both sides of each looked mixed up. It now picks the thread from where you wrote from and to: when you write from your number to your Apple ID, your words stay on the right and the agent's land on the left. Its own reflected copies are never read back as yours, even if the invisible marker is lost.
- A bot's page now says in its Permissions section when the bot only hears group messages that @ it — covering Telegram and Discord too, with a "Turn on" link to each platform's setting — and it is checked again when the window regains focus. A Feishu bot added to a group also reads its recent messages as background the agent can read, and Feishu @all messages are kept instead of dropped.
- A Feishu bot added back to a group no longer reads its own earlier messages there as another bot's.
- A Slack bot's own posts that arrive under its bot ID alone are no longer read back as another bot's.

## 0.1.16

- Feishu bots join groups like a person: apps created by scanning now ask for "all group messages" (`im:message.group_msg`) by default, so every group message is kept as background the agent can read — with the `unseen` count on the next trigger — and group history works through the messages API, instead of the bot only hearing @mentions.
- A connected Feishu bot can pick up new permissions without being reconnected: its settings page has a Permissions section with "Update permissions…", which runs the same scan to add the missing grants to the existing app; Feishu's confirm page lists exactly what is being added.
- Feishu chats can list their members now, using the group-info permission the app already had.

## 0.1.15

- Settings → "Brains" now shows each harness's quota under its row: one line with the signed-in account's usage windows for Claude Code, Codex, Grok and Kimi Code, turning amber with the reset time once a limit is reached.

## 0.1.14

- Agent settings puts identity first — name and picture, then role and brain — and gives each chat app its own page in place, like a Mac settings pane: the bot and its actions, the access rule for that app, and the people who wrote to it. Contacts and Access are no longer separate sections; decided people carry their decision in their contact row, and the "ask about new people" switch shows only on apps where it changes anything.
- "Diagnose a problem" now copies a prompt for a local agent (Claude Code or Codex) on the same computer: it reads Mingle's log and the source at the running version, finds the cause, and drafts a redacted GitHub issue for your approval. A new `mingle log` command reads the log files directly, so it works even when Mingle is down.
- Finished harness updates are no longer reported as failed. A console left open used to show "The update did not finish" for updates that had succeeded, and an update offered for the version already installed counted its own success output as a failure.
- GitHub setup now warns to keep `Participating, @mentions and custom` set to `On GitHub` in the agent account's notification settings, or the agent never sees mentions.
- Chinese text that inserts a platform name now spaces it correctly ("在 Telegram 上"), with the spacing handled automatically for every such message.

## 0.1.13

- Strangers can no longer put your agent to work without asking. On public chat apps (Telegram, Discord, QQ), a new person's first DM, or the first @mention in a new group, is held for your approval under "Needs you" before it reaches the agent. Approving delivers the held messages in order; declining keeps them on record only. The decided people and groups can be revoked or re-allowed from Settings → "Access", where one switch extends the same approval to organization apps. Everyone already talking to your agent, and every existing group, stays allowed.
- Owning a bot on Telegram, Slack, DingTalk and WeCom is no longer "first DM wins": the console shows a 6-digit claim code (valid 10 minutes, regenerable), and only a DM carrying it makes you the owner. Messages sent before claiming are treated as a stranger's.
- Other bots' messages no longer wake the agent. They are saved as background the agent can read, marked `bot`, and only an explicit @mention in the message body triggers a reply. Five back-and-forth rounds with a bot in one chat stops the loop until a person speaks. A direct message from a bot never triggers.
- A person can be recognized across chat apps: link their accounts together in Settings → "Contacts" or with `mingle contact link`, add a short note, and find every account with `mingle contact info`. Only the owner's links carry access decisions — approving one account approves the whole person; agent-made links pass no permissions.
- You can hand an agent what another conversation knows: Settings → "Handoff" copies a prompt for a temporary Claude Code, Codex or web chat to write a handoff, sent with `mingle handoff <agent>` or pasted directly (up to 200 KB). The agent files it into its own memory and tasks; nothing is announced in your chat apps.

## 0.1.12

- Agents can be renamed and given a picture from Settings → "Name and picture": choose or drop an image, frame it in place, and save it as a 256 px PNG. Chat-app bot pictures are not synced.
- Reminders can be cancelled and open tasks closed directly from the console. Both work even while the agent is paused, stuck or offline, and the agent is told with its next input.
- An installed harness that has a newer version can be updated from its Settings row; the console asks the harness's own update source and offers the update only when one exists.
- Signing in to GitHub now shows a device code to enter on github.com by default, through Mingle's OAuth App; pasting a classic token remains available as the fallback.
- DingTalk setup works again: its authorization page now uses DingTalk's device-registration source identifier instead of being rejected as an unavailable source.
- The desktop window's waiting page follows the console's look instead of showing unstyled text, its restart state points to the logs rather than printing internal errors, and a blank window recovers by itself when its web content process dies.
- The side panel no longer repeats the chat-app list under Agent settings; each side-panel row opens that bot's row in settings instead.

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
