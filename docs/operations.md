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

Merging a reviewed pull request into protected `main` triggers the Cloudflare
production build and Worker deployment. Follow its status under the Worker's
**Deployments** page.

After pulling the same change locally, refresh the client build, launchers, and
unit paths:

```sh
npm install
./scripts/configure
systemctl --user daemon-reload
systemctl --user restart toggl-waybar-live.service
```

## Roll back the Worker

Cloudflare retains recent Worker versions. To restore the version immediately
before the active one:

```sh
npx wrangler rollback --config worker/wrangler.jsonc
```

To choose a specific version, open the Worker in Cloudflare, select
**Deployments**, open the version's three-dot menu, and select **Rollback**.
Rollback changes the active Worker version; it does not modify the Git branch,
so follow it with a corrective pull request.

## Remove the integration

First delete the Toggl webhook subscription using an authenticated `DELETE` to:

```text
https://api.track.toggl.com/webhooks/api/v1/subscriptions/WORKSPACE_ID/SUBSCRIPTION_ID
```

Disconnect **Settings > Builds** before removing the Cloudflare Worker so a
later push cannot recreate a deployment. Then remove the Worker:

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
