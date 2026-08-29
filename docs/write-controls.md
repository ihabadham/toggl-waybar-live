# Local write controls and Toggl drawer

Status: approved for implementation

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

While running, the drawer shows the current activity, live duration, project,
today's total, and a prominent Stop button. Recent activities remain visible
but cannot be selected until the current timer stops. Stopping from the drawer
keeps it open so another activity can be selected.

While idle, the drawer shows Resume Last and up to eight recent activities.
Selecting one starts it and closes the drawer. Escape, clicking outside, or
repeating the drawer shortcut closes it. Errors stay visible in the drawer.

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
Malformed and oversized messages are rejected.

The daemon serializes all mutations. State commits from commands, relay
messages, and reconciliation use one ordered transition path. A reconciliation
result that began before a mutation is discarded rather than overwriting the
newer command result.

### Resume presets

The daemon stores at most eight presets in an atomic mode-`0600` file under
`$XDG_STATE_HOME/toggl-waybar-live/`. Each preset contains a safe local ID,
workspace ID, description, project ID, task ID, tags, billable status, and its
last-used timestamp.

Presets update from rich REST responses and successful local mutations. The
narrow hosted webhook protocol is not expanded. A relay event may update timing
state without erasing richer local resume metadata. Presets survive midnight,
daemon restarts, and cache cleanup.

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

Only one mutation may be in flight. Explicit Stop and Resume operations are
state-specific, making repeated invocations harmless. Toggle additionally has
a short monotonic duplicate-suppression window so mouse double-clicks and key
repeat cannot stop and immediately restart a timer.

The UI may show `Stopping…` or `Resuming…`, but it does not claim the underlying
state changed until Toggl accepts the request. Toggl quota headers from writes
feed the same local quota accounting used by reconciliation, and interactive
commands take priority over background refreshes.

## Eww integration

Eww is an optional presentation dependency. The project supplies a dedicated
configuration with a right-anchored Wayland window, a slide transition, the
live watch stream, and buttons that invoke the local CLI. Eww receives no
credentials and performs no network requests.

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
exhausted, authentication failed, and ambiguous creation. A failed command
does not erase the last trusted timer state. Errors clear on dismissal or the
next successful command.

## Verification

Automated coverage includes:

- exact create and stop request paths, bodies, responses, and quota headers;
- preset identity, ordering, atomic persistence, midnight, and restart behavior;
- valid, malformed, and oversized socket messages and socket permissions;
- command serialization, duplicate toggle suppression, and daemon absence;
- stale-state confirmation and ambiguous creation recovery;
- external stop conflicts, webhook echoes, and reconciliation races;
- the live drawer view stream; and
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
