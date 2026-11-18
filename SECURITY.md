# Security

Mingle runs on your machine and holds credentials for your chat apps, so security reports matter a lot to us.

## Reporting a vulnerability

Please report it privately through [GitHub's security advisories](https://github.com/earayu/Mingle/security/advisories/new), not in a public issue. Include what an attacker can do, the steps to reproduce, and the Mingle version. We'll reply as soon as we can and keep you updated until a fix is released.

## Supported versions

Fixes go into the latest release. The desktop app updates itself; if you build from source, update to the latest `main`.

## Scope

Things we especially want to hear about:

- The local API (`127.0.0.1`) being reachable or usable from another machine, a web page or another local user
- Chat app credentials leaking into the database, logs or API responses
- An agent acting for someone who isn't allowed to reach it
