# Local write controls and Toggl drawer

## Goal

Add safe local controls for stopping the current Toggl timer, resuming the
last activity, and starting one of eight recent activities. Add an optional
right-edge Eww drawer that exposes those controls without turning this project
into a general Toggl client or desktop shell.

The Cloudflare relay remains read-only. All mutations originate locally and
pass through the existing daemon, which remains the only process that owns the
Toggl API token and authoritative local state.

## User experience

The primary action is state-aware:

- Left-clicking the Waybar module or pressing `Super+T` stops a running timer.
- The same action while idle resumes the most recently used activity.
- If no resumable activity exists, the action opens the drawer.

Right-clicking the Waybar module or pressing `Super+Shift+T` toggles the
drawer. A mouse invocation opens it on the Waybar output that received the
click. A keyboard invocation opens it on the currently focused output. Only
one drawer is visible at a time.

The drawer keeps its actions ahead of history: current activity and primary
Stop or Resume Last control, up to eight Quick Resume rows, then Today, This
Week, and This Month at a glance. Quick Resume remains visible but disabled
while a timer is running. Stopping from the drawer keeps it open; choosing an
activity while idle starts it and closes the drawer.

Today starts collapsed each time the drawer opens. Its glance shows the live
total and entry count; selecting it reveals newest-first rows with description,
project/task context, local start-stop range, and duration. Running rows and
the Today total tick locally. This Week and This Month show compact
hours-and-minutes totals, with visible stale or partial cues when applicable.

Escape, clicking outside, or repeating the drawer shortcut closes it. Errors
stay visible in the drawer.

The recent list contains distinct resumable activities rather than raw time
entries. Identity is the exact combination of workspace, description, project,
task, tags, and billable status. Reusing an activity moves it to the front.

## Architecture

```text
Waybar / Sway shortcuts / Eww drawer
                  |
                  v
       credential-free local CLI
                  |
                  v
$XDG_RUNTIME_DIR/toggl-waybar-live/control.sock
                  |
                  v
            local daemon
          /       |       \
         v        v        v
 Toggl REST   preset state  live UI projections
                                |        |
                                v        v
                             Waybar     Eww
```

The Worker, Durable Object, webhook protocol, and relay WebSocket protocol do
not change. Webhooks continue to confirm mutations and capture changes made by
other Toggl clients.

All Toggl REST reads, writes, and confirmation requests pass through one local
scheduler. It permits one active request, spaces request starts by at least one
second, and gives admitted control work priority over queued background reads.
Queued background work is discarded if newer state makes its result irrelevant.

### Local control protocol

A new credential-free CLI communicates with the daemon through a Unix socket
inside the existing private runtime directory. Its initial command surface is:

- `toggl-waybar toggle`
- `toggl-waybar stop`
- `toggl-waybar resume [preset-id]`
- `toggl-waybar watch`

The watch command emits newline-delimited JSON view models for Eww. Commands
use constrained command names and preset identifiers; descriptions and other
user-controlled labels are never parsed as shell commands or identifiers.
Requests and responses use a small versioned, runtime-validated local schema.
Malformed and oversized messages are rejected. Frames are capped at 64 KiB;
the daemon keeps projected snapshots within 48 KiB by including at most 50
newest Today rows and reporting the number of earlier rows omitted.

The daemon admits only one mutation at a time. Concurrent commands fail fast
instead of waiting in a write backlog. State commits from commands, relay
messages, and reconciliation use one ordered transition path. A reconciliation
result that began before a mutation is discarded rather than overwriting the
newer command result.

A local or REST-confirmed running entry is protected until the relay catches
up to that entry. REST-confirmed idle is protected as well, so a delayed relay
snapshot cannot resurrect an older unseen timer after startup or reconnect.
When relay order is ambiguous, the daemon retains the newest relay candidate
by its server cursor and performs one coalesced current-entry check. It does not
assume that adjacent snapshot and change frames belong to the same transition.
This also covers an external switch whose create event arrives before the stop
event for the previous timer.

### Resume presets

The daemon stores at most eight presets in an atomic mode-`0600` file under
`$XDG_STATE_HOME/toggl-waybar-live/`. Each preset contains a safe local ID,
workspace ID, description, project ID, task ID, tags, billable status, and its
last-used timestamp.

Presets update from rich REST responses and successful local mutations. The
narrow hosted webhook protocol is not expanded. A relay event may update timing
state without erasing richer local resume metadata. Presets survive midnight,
daemon restarts, and cache cleanup.

### Today, week, and month projection

The daemon owns the Today timeline and current-week and current-month
aggregates in memory. They use local day, configured week-start, or month
boundaries in the configured IANA timezone, with an entry attributed to the
period in which it started. Entries spanning a boundary are not split.
Repeated descriptions remain separate time-entry rows.

The drawer receives bounded Today rows and only the week and month aggregates,
never full history. A single local one-second tick advances the current timer,
Today total, running Today row, and eligible week and month totals from the
latest watch snapshot. Ticking does not open another subscription, reread
configuration, or call Toggl.

The shared week/month history read is optional and runs at most hourly inside
full reconciliation, after Today and current state succeed. Before its first
success, the drawer shows an em dash. A later failure preserves the last value
and marks it stale. A response reaching the 1,000-entry ceiling is treated as
partial and displayed as a lower bound with `≥`; partial and stale cues can
appear together. Month
availability never disables Stop, Resume Last, or Quick Resume.

## Mutation behavior

### Stop

Stop requires a trusted current entry and sends Toggl's workspace-scoped stop
request. A successful response is applied and published immediately. An
already-stopped response converges to idle. A missing entry triggers
reconciliation rather than an automatic retry.

### Resume

Toggl has no resume endpoint. Resume creates a new running entry with the
preset's workspace, description, project, task, tags, and billable status, plus
a new start time and this application's `created_with` value.

Resume is allowed only from confirmed idle state. It never silently stops an
existing timer. A successful response becomes the current entry immediately;
the later webhook is an idempotent confirmation.

Creation has no documented idempotency key. An ambiguous network failure is
therefore never retried blindly. The daemon performs one current-entry check.
If it still cannot determine whether creation succeeded, it reports an
uncertain result and blocks another resume until reconciliation establishes a
trusted state.

### Stale state and duplicate input

When relay state is stale, the daemon confirms the current entry through Toggl
before interpreting a toggle. If confirmation cannot complete, the command
fails without mutating anything.

Only one mutation may be in flight. A concurrent command returns
`command_busy` immediately and is never run later. Explicit Stop and Resume
operations are state-specific, making repeated invocations harmless. Toggle
additionally has a short monotonic duplicate-suppression window so mouse
double-clicks and key repeat cannot stop and immediately restart a timer.
An admitted command makes at most four deadline-bounded Toggl requests, including
an already-running relay conflict check that the command waits for and reuses. The
local client's response timeout is derived from that maximum plus local
processing grace, so it does not expire before one worst-case operation. Preset
persistence continues on the daemon's tracked persistence queue and is drained
during shutdown; it does not hold the interactive response open.

The UI may show `Stopping…` or `Resuming…`, but it does not claim the underlying
state changed until Toggl accepts the request. Toggl quota headers from writes
feed the same local quota accounting used by reconciliation, and interactive
commands take priority over queued background refreshes. Ambiguous relay bursts
admit at most one current-entry confirmation at a time; that confirmation is
recorded in the same quota gate and is skipped while its reserve is active.

## Eww integration

Eww is an optional presentation dependency. The project supplies a dedicated
configuration with a right-anchored Wayland window, a slide transition, one
scrollable action-first surface, the live watch stream, and buttons that invoke
the local CLI. Eww receives no credentials and performs no network requests.

The project does not install Eww through a system package manager. A separate
drawer setup command validates the dependency and installs only this project's
configuration and launcher. Existing Waybar-only installations continue to
work without Eww.

Desktop configuration examples document the Waybar click actions and Sway
bindings. Setup does not silently rewrite a user's Waybar or Sway files.

Installed JavaScript and UI assets are copied into a stable XDG data location.
Launchers do not point back into the clone or worktree that ran setup. This
prevents later worktree removal from breaking the running service.

## Failure display

Pending state is visible in Waybar and the drawer. Drawer failures are concise
and actionable, including daemon unavailable, state unconfirmed, quota
exhausted, authentication failed, ambiguous creation, and another command
already being active. A failed command does not erase the last trusted timer
state. Errors clear on dismissal or the next successful command.

## Verification

Automated coverage includes:

- exact create and stop request paths, bodies, responses, and quota headers;
- preset identity, ordering, atomic persistence, midnight, and restart behavior;
- valid, malformed, and oversized socket messages and socket permissions;
- bounded command admission, duplicate toggle suppression, and daemon absence;
- stale-state confirmation and ambiguous creation recovery;
- startup idle fencing, create-before-stop external switches, webhook echoes,
  and reconciliation races;
- bounded Today/month projections and the one-second local drawer tick;
- prioritized, serialized, and paced Toggl request scheduling;
- Today disclosure reset, month cues, and the live drawer view stream; and
- fake-Toggl end-to-end stop, resume-last, and resume-selected flows.

Manual verification covers mouse and keyboard control, animation and focus,
output selection on both configured monitors, errors, and suspend/resume. It
uses deliberate test entries and does not repeatedly consume production quota.

## Non-goals

- Switching activities through an automatic stop-then-start transaction.
- Editing, deleting, or creating arbitrary entry details.
- Synchronizing Toggl Favorites.
- Building a broader system control center.
- Replacing Waybar, Dunst, or the existing Sway setup.
- Sending write commands or the Toggl API token through Cloudflare.
