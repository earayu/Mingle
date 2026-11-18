# Remote SSH (development)

English · [中文](remote-ssh_CN.md)

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
