# Operations

## Status and logs

```sh
systemctl --user status toggl-waybar-live.service
journalctl --user -u toggl-waybar-live.service -f
```

Daemon logs are one-line JSON with event, severity, and timestamp fields. They
do not contain tokens, authorization headers, entry descriptions, or config
values.

## Recovery

Restarting performs an immediate full reconciliation and reconnects the relay:

```sh
systemctl --user restart toggl-waybar-live.service
```

The disconnected worst case is 18 Toggl requests per hour: six two-request
full reconciliations and six current-only checks. The gate stops with six quota
slots remaining and honors Toggl's reset header. The visible timer continues
locally while stale and is marked with `⚠`.

If the runtime file is corrupt or missing, renderers show `Toggl offline` until
the daemon publishes a valid replacement. Runtime state lives under
`$XDG_RUNTIME_DIR/toggl-waybar-live/` and contains no credentials.

## Update a clone

After pulling code, refresh the build, launchers, and unit paths:

```sh
npm install
./scripts/configure
systemctl --user daemon-reload
systemctl --user restart toggl-waybar-live.service
```

## Remove the integration

First delete the Toggl webhook subscription using an authenticated `DELETE` to:

```text
https://api.track.toggl.com/webhooks/api/v1/subscriptions/WORKSPACE_ID/SUBSCRIPTION_ID
```

Then remove the Cloudflare Worker:

```sh
npx wrangler delete --config worker/wrangler.jsonc
```

Remove `custom/toggl` from Waybar and restore any module it replaced. Finally:

```sh
systemctl --user disable --now toggl-waybar-live.service
rm ~/.config/systemd/user/toggl-waybar-live.service
rm -rf ~/.config/toggl-waybar-live
rm ~/.local/bin/toggl-waybar-daemon ~/.local/bin/toggl-waybar-render
systemctl --user daemon-reload
```

The last commands remove only this project's named files. The Cloudflare and
Toggl deletions are separate so local removal cannot silently leave a webhook
or hosted relay behind.
