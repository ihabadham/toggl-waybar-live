# toggl-waybar-live

Toggl Track status for Waybar, delivered through a small Cloudflare relay and
rendered locally.

An authenticated Toggl webhook updates a hibernating Cloudflare Durable Object.
One local daemon receives those updates and reconciles against Toggl within a
strict request budget. Any number of Waybar renderers read the same private
runtime file and advance the timer locally once per second.

```text
● PR review e… │ 01:23:45
○ Today │ 05:42:17
```

The first supported desktop is Fedora with Sway, Waybar, and a systemd user
session. Start with [the setup guide](docs/setup.md). The architecture and
failure behavior are documented in [the design](docs/design.md), with recovery
commands in [operations](docs/operations.md).

Cloudflare Workers Builds can connect the deployed Worker to the repository and
run `npm run deploy` automatically whenever protected `main` changes. Runtime
secrets stay in Cloudflare rather than GitHub.

The project is not yet packaged. Installation currently uses a checked-out
clone and creates refreshable launchers under `~/.local/bin`.
