# Setup

The first release builds from a checked-out clone, uses Cloudflare's free
Workers platform, and receives a Toggl webhook. Cloudflare Workers Builds
deploys reviewed changes from `main`; GitHub never receives Cloudflare
credentials.

## Install dependencies

Core requirements: Node.js 22 or newer, npm, OpenSSL, systemd user services,
and Waybar. The optional drawer requires Eww v0.6.0, its compatibility target;
install it with the [official Eww installation guide](https://elkowar.github.io/eww/#how-to-install-eww).

```sh
npm install
```

## Provision the Cloudflare relay

Authenticate Wrangler and deploy from this repository:

```sh
npx wrangler login
npm run deploy
```

Copy the resulting HTTPS Worker URL. The webhook callback is that URL followed
by `/webhooks/toggl`; the daemon URL uses `wss://` followed by `/ws`.

## Configure the local client

```sh
./scripts/configure
```

Enter the deployed Worker's `wss://.../ws` URL when prompted. The command also
prompts for the IANA timezone and Toggl API token. It generates a 32-byte relay
token without printing it. Rerunning it rebuilds the client, refreshes
the stable installed bundles and launchers, and preserves the existing relay
token. It does not enable or restart the systemd service.

Local secrets are stored at `~/.config/toggl-waybar-live/env` with mode `0600`.
The API token remains local and is never sent to Cloudflare.

Core runtime bundles are copied to
`${XDG_DATA_HOME:-$HOME/.local/share}/toggl-waybar-live/client/`. The
`toggl-waybar-daemon`, `toggl-waybar-render`, and `toggl-waybar` launchers in
`${TOGGL_WAYBAR_BIN_DIR:-$HOME/.local/bin}` reference only those installed
artifacts, not the source checkout. The installer also writes the named systemd
user unit under `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/`. Existing
symlink targets are refused rather than followed.

Set the local relay token as the Worker secret without printing it:

```sh
sed -n 's/^TOGGL_RELAY_TOKEN=//p' ~/.config/toggl-waybar-live/env |
  npx wrangler secret put RELAY_TOKEN --config worker/wrangler.jsonc
```

Set your numeric Toggl user ID:

```sh
npx wrangler secret put TOGGL_USER_ID --config worker/wrangler.jsonc
```

Generate one webhook signing secret, upload it to Cloudflare, and use the same
value as the `secret` field when creating the Toggl subscription:

```sh
umask 077
openssl rand -hex 32 > .webhook-secret
npx wrangler secret put TOGGL_WEBHOOK_SECRET --config worker/wrangler.jsonc < .webhook-secret
```

Create the subscription. This exact flow keeps the API token and signing secret
out of command-line arguments; it requires `curl` and `jq`:

```bash
umask 077
read -r -p 'Toggl workspace ID: ' WORKSPACE_ID
read -r -p 'Worker HTTPS URL (without a trailing slash): ' WORKER_URL
read -r -s -p 'Toggl API token: ' TOGGL_API_TOKEN
printf '\n'

printf 'machine api.track.toggl.com login %s password api_token\n' "$TOGGL_API_TOKEN" > .toggl-netrc
unset TOGGL_API_TOKEN

jq -n \
  --arg callback "$WORKER_URL/webhooks/toggl" \
  --arg secret "$(cat .webhook-secret)" \
  '{
    url_callback: $callback,
    event_filters: [
      {entity: "time_entry", action: "created"},
      {entity: "time_entry", action: "updated"},
      {entity: "time_entry", action: "deleted"}
    ],
    enabled: true,
    description: "toggl-waybar-live",
    secret: $secret
  }' > .webhook-request.json

curl --fail-with-body --silent --show-error \
  --netrc-file .toggl-netrc \
  -H 'Content-Type: application/json' \
  --data-binary @.webhook-request.json \
  "https://api.track.toggl.com/webhooks/api/v1/subscriptions/$WORKSPACE_ID" \
  > .webhook-response.json

jq 'del(.secret)' .webhook-response.json
```

The Worker echoes Toggl's signed validation ping. Confirm the returned
subscription has a non-null `validated_at`, then delete the temporary secret:

```sh
rm .webhook-secret .webhook-request.json .webhook-response.json .toggl-netrc
```

Keep the returned workspace and subscription IDs for removal.

## Enable automatic Worker deployment

Connect the existing Worker to the Git repository using Cloudflare Workers
Builds:

1. In Cloudflare, open **Workers & Pages** and select the Worker.
2. Open **Settings > Builds**, select **Connect**, and authorize the Cloudflare
   GitHub App if prompted.
3. Select this repository and use these build settings:

   | Setting | Value |
   | --- | --- |
   | Production branch | `main` |
   | Root directory | `/` |
   | Build command | `npm run build` |
   | Deploy command | `npm run deploy` |

4. Under **Settings > Build > Branch control**, disable **Builds for
   non-production branches**. Cloudflare does not provide preview URLs for
   Workers that use Durable Objects, and pull requests are already verified by
   GitHub Actions.

The existing Worker name must match the `name` in `worker/wrangler.jsonc` or
Cloudflare rejects the connection. Once connected, each push to protected
`main` installs the exact lockfile and deploys the Worker.

The relay bearer token, webhook signing secret, and target user ID remain
runtime secrets in Cloudflare. They are not build variables and are preserved
when a new code version is deployed.

## Enable the daemon

```sh
systemctl --user daemon-reload
systemctl --user enable --now toggl-waybar-live.service
systemctl --user status toggl-waybar-live.service
```

## Add the Waybar module

Copy the `custom/toggl` definition from `examples/waybar.jsonc` into the active
Waybar config. In `modules-right`, replace `temperature` with `custom/toggl`.
Merge `examples/waybar.css` into the active stylesheet, then reload Waybar.
Change `TOGGL_LABEL_MAX_CHARS=12` in the module's `exec` command to choose a
different visible label width.

The example binds left click to `toggl-waybar toggle`. Toggle stops a confirmed
running entry, resumes the most recent activity while confirmed idle, or opens
the optional drawer when no activity can be resumed. Pending stop/resume state
is visible without claiming the mutation succeeded early.

The renderer is long-lived. Waybar does not start a process every second; it
reads one JSON line per second from the same renderer process. Multiple outputs
may each run a renderer without adding WebSocket or Toggl requests.

## Install the optional drawer

Install the supported Eww v0.6.0 first, following the official guide linked
above, then run:

```sh
./scripts/configure-drawer
```

The command requires an already-installed core `toggl-waybar` CLI and an `eww`
executable. It atomically installs the drawer bundle, its dedicated Eww config,
`toggl-waybar-drawer`, and the `toggl-waybar-drawer.service` systemd user unit.
The unit keeps Eww in the foreground with the Wayland backend and belongs to the
graphical session. The installer never invokes a package manager, reloads or
starts systemd, or changes Sway or Waybar files. The config lives under
`${XDG_CONFIG_HOME:-$HOME/.config}/toggl-waybar-live/eww/`. Rerun the command
after upgrading the checkout whenever drawer code or Eww assets change.

Enable the optional service after installation:

```sh
systemctl --user daemon-reload
systemctl --user enable --now toggl-waybar-drawer.service
systemctl --user status toggl-waybar-drawer.service
```

Copy the relevant bindings from `examples/sway.conf` into the active Sway
config. `Super+T` toggles the timer, `Super+Shift+T` toggles the drawer, and the
sample `toggl-waybar-drawer` mode lets Escape close it. Reload Sway after merging
the fragment; do not restart the compositor.

Each open resets Today to its compact total-and-entry-count view; select Today
to reveal or hide the newest-first timeline. Quick Resume stays visible but is
disabled while a timer runs. Stop keeps the drawer open so another activity can
be selected, while Resume Last or a selected Quick Resume row closes it after a
successful start.

The portable Waybar and keyboard commands open the drawer on the currently
focused workspace output. Waybar does not provide a generic click command with
the clicked output name. Exact click-output placement therefore requires a
separate, output-specific Waybar block with a hardcoded command such as:

```jsonc
"on-click-right": "~/.local/bin/toggl-waybar-drawer toggle --output DP-1"
```

Use the real output name from `swaymsg -t get_outputs`; do not use a fictional
`$WAYBAR_OUTPUT_NAME` variable.

The webhook commands follow Toggl's [subscription request
format](https://engineering.toggl.com/docs/track/webhooks_start/request_examples/).
Cloudflare secrets are installed with Wrangler's [secret
command](https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret).
Workers Builds follows Cloudflare's documented [Git integration
flow](https://developers.cloudflare.com/workers/ci-cd/builds/) and [build
configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).
The production-only branch setting follows Cloudflare's [build branch
controls](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/).
