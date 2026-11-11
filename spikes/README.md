# Spikes

Throwaway scripts that back the "verified" table in `docs/spec.md` section 12. Not part of the product.

## oar-session.mjs

Drives a real harness through OAR: injects an environment variable and an appended system prompt, delivers two messages while a tool is running, then resumes the session from a second process.

```sh
mkdir -p /tmp/mingle-spike/home && cd /tmp/mingle-spike
npm init -y && npm i @botiverse/oar@0.97.0
cp <repo>/spikes/oar-session.mjs run.mjs
cd home
node ../run.mjs claude "$PWD"                          # first run, writes ../claude.session
node ../run.mjs claude "$PWD" "$(cat ../claude.session)"   # resume
```

Replace `claude` with `codex` for Codex. Each run spends a small amount of the harness's own quota.
