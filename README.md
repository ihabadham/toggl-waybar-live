# toggl-waybar-live

Toggl Track status and safe local controls for Waybar, delivered through a
small read-only Cloudflare relay and rendered locally.

An authenticated Toggl webhook updates a hibernating Cloudflare Durable Object.
One local daemon receives those updates and reconciles against Toggl within a
strict request budget. Any number of Waybar renderers read the same private
runtime file and advance the timer locally once per second. A credential-free
local command can stop the current timer or resume one of eight recent
activities through the daemon. Mutations never pass through Cloudflare.

```text
● PR review e… │ 01:23:45 · Σ05:42
○ Today │ 05:42:17
```

The first supported desktop is Fedora with Sway, Waybar, and a systemd user
session. Start with [the setup guide](docs/setup.md). The architecture and
failure behavior are documented in [the design](docs/design.md), with recovery
commands in [operations](docs/operations.md).

Left-clicking the example Waybar module or pressing `Super+T` toggles the timer.
Right-clicking or pressing `Super+Shift+T` opens an optional right-edge Eww
drawer. Eww is not required for the core daemon, renderer, or CLI and is never
given the Toggl token.

Cloudflare Workers Builds can connect the deployed Worker to the repository and
run `npm run deploy` automatically whenever protected `main` changes. Runtime
secrets stay in Cloudflare rather than GitHub.

The project is not yet distributed as an OS package. Its setup scripts build
self-contained Node bundles into a stable XDG data directory and create
launchers under `~/.local/bin`; removing the source checkout does not break an
installed client. Setup does not enable services, install Eww, or edit Sway and
Waybar configuration.
