# Operations

## Status and logs

```sh
systemctl --user status toggl-waybar-live.service
journalctl --user -u toggl-waybar-live.service -f
```

If the optional drawer is installed, its Eww daemon has a separate service and
log stream:

```sh
systemctl --user status toggl-waybar-drawer.service
journalctl --user -u toggl-waybar-drawer.service -f
```

Daemon logs are one-line JSON with event, severity, and timestamp fields. They
do not contain tokens, authorization headers, entry descriptions, or config
values.

## Recovery

Restarting performs an immediate full reconciliation and reconnects the relay:

```sh
systemctl --user restart toggl-waybar-live.service
```

The scheduled-maintenance worst case is 19 Toggl requests per hour: twelve from
six full Today/current reconciliations, six disconnected current-only checks,
and one hourly month refresh. That leaves eleven requests below Toggl's
documented 30-request quota before user-triggered writes or conflict checks.
The shared quota gate is stricter in practice: it stops background work when
Toggl reports six or fewer requests remaining and honors the reset header.
One local scheduler serializes and paces every request, while admitted controls
take priority over queued maintenance. The visible timer continues locally
while stale and is marked with `⚠`.

If the runtime file is corrupt or missing, renderers show `Toggl offline` until
the daemon publishes a valid replacement. Runtime state lives under
`$XDG_RUNTIME_DIR/toggl-waybar-live/` and contains no credentials.

The drawer keeps the last trusted state visible when a command fails. Its
stable messages have these meanings:

| Message | Action |
| --- | --- |
| `Toggl daemon unavailable` | Start or inspect the user service. |
| `Timer state could not be confirmed` | Restore connectivity and wait for reconciliation before toggling again. |
| `Toggl request quota exhausted` | Wait for the Toggl quota reset; do not loop commands. |
| `Toggl authentication failed` | Rerun core configuration with a valid API token, then restart the service. |
| `Timer may have started; waiting for confirmation` | Check Toggl once; do not resume again until the daemon confirms current state. |
| `That recent activity is no longer available` | Reopen the drawer and choose a current preset. |
| `Toggl request failed` | Keep the displayed trusted state and inspect daemon logs before retrying. |

Recent activities are stored separately at
`${XDG_STATE_HOME:-$HOME/.local/state}/toggl-waybar-live/presets.json` with mode
`0600`. Removing the runtime or cache directory does not remove them.

### Diagnose the month total

The This Month card reports degraded history without disabling timer controls:

| Display | Meaning |
| --- | --- |
| `—` | No successful refresh exists for the current local month yet. |
| A duration with no cue | The latest month refresh is complete. |
| `≥` and `partial` | Toggl returned the 1,000-entry ceiling, so the value is a lower bound. |
| `stale` | A refresh failed after a prior success; the last trusted value remains visible. |
| `partial · stale` | The preserved lower bound is also stale. |

To inspect the exact drawer projection, run this and press Ctrl+C after a line:

```sh
~/.local/bin/toggl-waybar watch | jq -c '.month'
```

An isolated month failure preserves successful Today/current reconciliation,
so it does not produce the core `reconciliation_failed` event. If Today or the
current timer also fails to reconcile, inspect the daemon log for that event
and the surrounding connection state. Opening the drawer never forces a month
request; the next eligible full reconciliation retries it without exceeding
the one-hour attempt guard.

## Upgrade the local client

Merging a reviewed pull request into protected `main` triggers the Cloudflare
production build and Worker deployment. Follow its status under the Worker's
**Deployments** page.

After pulling the same reviewed change locally, atomically refresh the core
bundles, launchers, private environment, and unit. If the optional drawer is
installed, refresh it separately:

```sh
npm install
./scripts/configure
./scripts/configure-drawer  # optional; requires Eww
systemctl --user daemon-reload
systemctl --user restart toggl-waybar-live.service
systemctl --user restart toggl-waybar-drawer.service  # if installed
```

Neither installer enables, starts, or restarts a service. The installed
launchers refer to stable XDG copies and pin Node's executable path; the drawer
unit likewise pins Eww's executable path. Switching or deleting source
worktrees does not change the running version until an installer is rerun.

## Roll back the local client

Check out the last reviewed revision you want to restore, install its locked
dependencies, and rerun `scripts/configure`. Rerun `scripts/configure-drawer`
too if that revision includes the drawer. Then reload systemd and restart the
service using the commands above. The existing relay token is preserved, but
the core installer prompts again for the local API token, timezone, and relay
URL.

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

## Manual desktop verification

Use deliberate short-lived test entries rather than repeatedly consuming
production quota:

1. On each of two configured outputs, confirm the renderer advances once per
   second without repeated Toggl reads.
2. Verify left click and `Super+T` stop while running and resume the latest
   activity while idle. Confirm pending styling clears after each result.
3. Open and close the drawer by right click, `Super+Shift+T`, Escape, backdrop,
   and the repeated shortcut. Confirm Stop leaves it open and a successful
   preset resume closes it.
4. While running, confirm Quick Resume remains visible but disabled. Stop the
   timer, resume a selected row, and confirm its description and project/task
   context were preserved.
5. Expand Today and verify the live total, entry count, newest-first ranges,
   durations, and running row. Close and reopen the drawer; Today should start
   collapsed. Confirm the current timer, Today total, running row, and eligible
   month total advance from the one local watch stream.
6. Check This Month against Toggl for the same configured timezone. If the card
   shows `partial` or `stale`, interpret it using the table above instead of
   treating it as an exact fresh value.
7. Verify the portable command follows the focused output. If output-specific
   Waybar blocks are configured, click each and confirm its hardcoded `--output`
   target receives the drawer.
8. Suspend while a timer runs, change timer state from another Toggl client if
   practical, resume, and confirm stale state is shown until reconnect and
   reconciliation restore the correct timer.
9. Temporarily stop the daemon and confirm the failure message is actionable,
   then start it and verify the watch stream reconnects.

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
~/.local/bin/toggl-waybar-drawer close 2>/dev/null || true
systemctl --user disable --now toggl-waybar-drawer.service 2>/dev/null || true
systemctl --user disable --now toggl-waybar-live.service
rm ~/.config/systemd/user/toggl-waybar-live.service
rm ~/.config/systemd/user/toggl-waybar-drawer.service 2>/dev/null || true
rm -rf ~/.config/toggl-waybar-live
rm -rf ~/.local/share/toggl-waybar-live
rm -rf ~/.local/state/toggl-waybar-live
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/toggl-waybar-live"
rm ~/.local/bin/toggl-waybar-daemon ~/.local/bin/toggl-waybar-render
rm ~/.local/bin/toggl-waybar ~/.local/bin/toggl-waybar-drawer
systemctl --user daemon-reload
```

Adjust the XDG and launcher paths if non-default locations were used. These
commands remove only this project's named files and directories, including
persisted presets and its disposable cache. The Cloudflare and Toggl deletions
are separate so local removal cannot silently leave a webhook or hosted relay
behind.
