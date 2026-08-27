# Setup

The first release uses a checked-out clone, Cloudflare's free Workers platform,
and a Toggl webhook. Nothing deploys from GitHub, and GitHub never receives
Cloudflare credentials.

## Install dependencies

Requirements: Node.js 22 or newer, npm, OpenSSL, systemd user services, and
Waybar.

```sh
npm install
```

## Provision the Cloudflare relay

Authenticate Wrangler and deploy from this repository:

```sh
npx wrangler login
npx wrangler deploy --config worker/wrangler.jsonc
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
launchers for the current clone path, and preserves the existing relay token.

Local secrets are stored at `~/.config/toggl-waybar-live/env` with mode `0600`.
The API token remains local and is never sent to Cloudflare.

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

The renderer is long-lived. Waybar does not start a process every second; it
reads one JSON line per second from the same renderer process. Multiple outputs
may each run a renderer without adding WebSocket or Toggl requests.

The webhook commands follow Toggl's [subscription request
format](https://engineering.toggl.com/docs/track/webhooks_start/request_examples/).
Cloudflare secrets are installed with Wrangler's [secret
command](https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret).
