# toggl-waybar-live design

Status: approved for implementation

## Goal

Show the current Toggl Track entry in Waybar with a locally advancing timer.
Starting, editing, or stopping an entry should normally appear within seconds,
without polling Toggl every second. When no entry is running, show today's
tracked total. Local controls can stop the trusted current entry or resume one
of eight recent activities without sending credentials or mutations through
Cloudflare.

The first supported environment is Fedora, Sway, Waybar, and systemd user
services. The core protocol and configuration must remain reusable without
building a generalized installer before the end-to-end path works.

## Non-goals for the first version

- Replacing the Toggl desktop or web application.
- Editing or deleting arbitrary entry details.
- Switching activities through an automatic stop-then-start transaction.
- Supporting multiple Toggl users through one relay deployment.
- Storing time-entry history in Cloudflare.
- Providing packages, automatic releases, or every init-system integration.
- Hiding an unhealthy connection behind apparently fresh data.

## User-visible behavior

The module has four primary states:

| State | Example |
| --- | --- |
| Running and connected | `● PR review… │ 01:23:45 · Σ05:42` |
| Idle and connected | `○ Today │ 05:42:17` |
| Running from stale state | `⚠ PR review… │ 01:23:45 · Σ05:42` |
| No usable state | `● Toggl offline` |

The visible entry label defaults to 12 characters, including an ellipsis when
truncated. It uses the description first, then the project name, then
`Running`. The active timer uses `HH:MM:SS` and advances locally once per
second. Running states append today's cumulative total as `ΣHH:MM`; minute
precision keeps the total glanceable without crowding the bar.

The tooltip contains the untruncated description, project, start time, today's
total, last synchronization time, and connection state. A stale running timer
continues from the last trusted start time but is visibly marked stale.

This bounded format is required because the narrower configured bar is 1536
logical pixels wide and its right side already contains several status
modules. Removing the temperature module does not provide enough room for an
unbounded project and description.

## System architecture

```text
Toggl Track webhook
        |
        v
Cloudflare Worker -- signature, target-user, and request validation
        |
        v
Durable Object -- latest snapshot and hibernating WebSocket fan-out
        |
        v
Local daemon -- one connection, reconciliation, local derived state
   ^    |    ^
   |    |    +-- private control socket <-- local CLI <-- Waybar / Sway / Eww
   |    +------> runtime state file <-- Waybar renderer on each output
   +----------- Toggl REST reads and user-requested writes
```

### Cloudflare Worker

The Worker exposes only three routes:

- `POST /webhooks/toggl` receives Toggl events.
- `GET /ws` upgrades an authenticated local client to WebSocket.
- `GET /health` returns a non-sensitive readiness response.

The webhook route validates method, content type, body size, and
`X-Webhook-Signature-256` over the unparsed request body. Only after the
signature succeeds does it parse the event and validate its callback URL,
delivery age, target Toggl user, and schema. The WebSocket route requires a
bearer token before forwarding the upgrade to the Durable Object.

There is one Durable Object instance per deployment, addressed by a stable
name. That is deliberate: version one is a single-user relay, not a hosted
multi-tenant service.

### Durable Object

The Durable Object serializes event handling, rejects duplicate or older
events, persists the latest active/idle snapshot, and broadcasts normalized
changes to connected clients.

It uses Cloudflare's WebSocket Hibernation API. Application heartbeat messages
use a WebSocket auto-response so they do not wake a hibernated object merely to
reply to a ping.

When an entry stops, the persisted snapshot becomes idle and no longer contains
its description or project. A normalized change may pass through memory to an
online client so the client can update today's total, but Cloudflare does not
retain a history of those changes.

### Local daemon

One systemd user service owns all network access. It:

- maintains one authenticated WebSocket, regardless of Waybar output count;
- fetches today's entries at startup and after a meaningful offline period;
- maintains today's entry map and project-name cache locally;
- serializes stop/resume commands received through a private Unix socket;
- persists up to eight exact resume activities under the XDG state directory;
- merges relay changes into the local derived state;
- writes the renderer state atomically; and
- reconnects with exponential backoff and jitter, capped at 60 seconds.

The daemon uses the user's configured IANA timezone to determine the local-day
boundary, then sends explicit RFC 3339 bounds to Toggl. Timestamps remain UTC
internally. This avoids incorrect totals around midnight and daylight-saving
changes.

### Local presentation and controls

Each Waybar output runs one small, long-lived renderer. A renderer reads shared
local state and emits Waybar JSON once per second. It performs no network
requests and owns no credentials. Multiple renderers therefore cost no Toggl
requests and create no additional WebSockets.

Runtime state lives under:

```text
$XDG_RUNTIME_DIR/toggl-waybar-live/state.json
```

The daemon updates it with write-then-rename semantics. Project metadata may be
cached under `$XDG_CACHE_HOME/toggl-waybar-live/`; cache loss affects labels,
not correctness of the running timer.

The credential-free `toggl-waybar` CLI sends only fixed command names and
validated preset UUIDs over `$XDG_RUNTIME_DIR/toggl-waybar-live/control.sock`.
It supports toggle, stop, resume, and a reconnecting watch stream. Toggle
confirms stale state before deciding whether to stop or resume. The optional
Eww drawer consumes the watch projection and invokes the same CLI; it performs
no network requests and receives no token.

## Toggl integration

The subscription uses the free-plan maximum of three time-entry filters:

```json
[
  { "entity": "time_entry", "action": "created" },
  { "entity": "time_entry", "action": "updated" },
  { "entity": "time_entry", "action": "deleted" }
]
```

Created events detect newly started entries, updated events detect stops and
edits, and deleted events remove entries from local totals or clear a matching
active entry. Events for users other than the configured target user are
acknowledged and ignored.

The daemon reconciles through `GET /api/v9/me/time_entries` with the current
local day's start and end, plus `GET /api/v9/me/time_entries/current`. The
second request is required because Toggl filters the list by entry start time;
an entry that began before local midnight can still be running today. Results
are merged by entry ID.

Local stop uses Toggl's workspace-scoped stop endpoint. Resume creates a new
entry containing the preset's workspace, description, project, task, tags, and
billable status. There is no automatic stop-then-start operation and no blind
retry when a create response is ambiguous. A later webhook is treated as an
idempotent echo of the already-applied local result.

### Quota budget

Healthy operation is push-driven. A full, two-request reconciliation is limited
to at most once per ten-minute window and normally occurs only at startup or
after a meaningful disconnection. While the relay is unavailable, a
current-entry-only check may run in the alternating five-minute window. All
Toggl REST calls share one local quota gate; project-name lookup is deferred
when that budget is low.

This caps this application's user-specific steady-state fallback at 18 requests
per hour: twelve current-entry checks and six daily-list requests.
That remains below Toggl's documented 30-request sliding-window quota. The
client also reads `X-Toggl-Quota-Remaining` and `X-Toggl-Quota-Resets-In`, stops
early when the budget is low, and honors Toggl's quota response instead of
retrying. Project lookup is cached and requested only for an unknown project
ID.

Interactive writes are additional user-triggered requests, not part of the
18-request disconnected fallback budget. Their quota headers feed the same
gate, so background reconciliation yields when Toggl reports low capacity.

## Protocol and state

Every relay message has a versioned envelope. Runtime validation occurs at both
network boundaries; TypeScript types alone are not treated as validation.

```ts
type RelayMessage =
  | { version: 1; type: "snapshot"; snapshot: RelaySnapshot }
  | { version: 1; type: "entry.changed"; entry: NormalizedEntry };

type RelaySnapshot =
  | {
      status: "running";
      entryId: string;
      workspaceId: string;
      projectId: string | null;
      description: string;
      start: string;
      eventCreatedAt: string;
      eventId: string;
    }
  | {
      status: "idle";
      updatedAt: string;
      eventCreatedAt: string;
      eventId: string;
    };
```

External numeric identifiers are normalized to decimal strings. This prevents
accidental precision assumptions and keeps protocol comparison explicit.

Toggl's stable event `created_at` establishes event order; `event_id` breaks a
tie. The delivery `timestamp` is used for replay-age validation, not ordering,
because it changes when Toggl retries a delivery. Reprocessing the same event
is a no-op.

The local state is richer than the hosted snapshot. It contains the current
entry, today's entry map and total, cached display names, connection status,
and synchronization timestamps. Only the renderer projection is written to the
runtime file.

The local control protocol is separately versioned and runtime-validated. Each
socket connection sends one request; watch connections receive state snapshots
until disconnected. Frames are capped at 64 KiB and the socket has mode `0600`.
Resume presets are strict, atomic mode-`0600` JSON under
`$XDG_STATE_HOME/toggl-waybar-live/`. Identity includes workspace,
description, project, task, tags, and billable state; reusing one preserves its
UUID and moves it to the MRU front.

## Security and data retention

Secrets are separated by purpose:

| Secret | Location | Purpose |
| --- | --- | --- |
| Toggl API token | local mode-`0600` configuration | REST reconciliation and subscription setup |
| Toggl webhook secret | Cloudflare Worker secret | verify webhook HMAC |
| Relay bearer token | Cloudflare Worker secret and local mode-`0600` configuration | authenticate WebSocket client |

No secret is accepted in a tracked configuration file, command argument, URL,
or Waybar configuration. Examples contain unmistakable placeholders. Setup
refuses empty values and known placeholders, writes local secret files with
mode `0600`, and uses `wrangler secret put` for Cloudflare.

The daemon is the only local process that reads the Toggl token. The CLI,
Waybar, Sway commands, Eww configuration, control socket messages, renderer
state, and preset file contain no credentials. User-controlled descriptions
and labels remain data; only fixed commands and validated UUIDs cross command
boundaries. Installer-owned files are atomically replaced, symlink targets are
rejected, and wrappers refer to installed XDG bundles instead of a checkout.

Webhook validation uses the raw body and a constant-time comparison. The
Worker validates the signed `url_callback` against its configured callback and
allows a small clock-skew margin for the delivery timestamp. Each subscription
gets its own random secret.

The Durable Object persists only the latest snapshot and ordering metadata. It
does not store completed entries, today's total, project names, the Toggl API
token, or webhook bodies. Logs exclude request bodies, authorization headers,
descriptions, and secret material.

## Failure behavior

| Failure | Behavior |
| --- | --- |
| WebSocket interruption | Mark state stale, continue a known timer, reconnect with bounded backoff |
| Worker unavailable | Use throttled Toggl REST fallback and retain visible stale status |
| Toggl REST unavailable or quota-limited | Keep last derived state, expose failure in tooltip, wait for allowed retry |
| Invalid webhook | Reject without changing state |
| Duplicate or out-of-order webhook | Acknowledge safely without rolling state backward |
| Corrupt runtime state | Renderer shows unavailable; daemon replaces it on the next valid projection |
| Daemon crash | systemd restarts it; startup reconciliation restores local state |
| Suspend/resume | WebSocket reconnect plus throttled reconciliation restores missed changes |
| Daemon unavailable during a command | CLI exits nonzero; watch shows an actionable unavailable view and reconnects |
| Stale state before toggle | Confirm the current entry once before choosing stop or resume |
| Ambiguous create response | Check current once, block another resume if still uncertain, and never retry blindly |
| Preset persistence failure | Preserve trusted timer state, report the failure, and do not write invalid preset data |

The local service must never enter a tight retry loop. Network and parsing
failures are observable in structured logs, while user-facing text remains
short.

## Repository shape

```text
worker/       Cloudflare Worker and Durable Object
client/       local daemon and Waybar renderer
shared/       protocol schemas and shared types
eww/          optional dedicated drawer configuration
examples/     Waybar, Sway, and systemd configurations
docs/         design and operating documentation
```

The repository uses TypeScript and npm workspaces. It will not introduce a web
framework, dependency-injection container, ORM, task orchestrator, or generic
plugin system. A dependency must remove meaningful implementation or testing
risk; convenience alone is insufficient.

The Worker, client, and shared protocol stay separate because they have real
runtime boundaries. Internal layers are introduced only when a second concrete
caller or independent test seam requires one.

## Verification strategy

### Unit tests

- Raw-body HMAC verification and rejection paths.
- Payload normalization and target-user filtering.
- Duplicate, retry, deletion, and out-of-order event handling.
- Local-day boundaries, duration math, and today-total updates.
- Visible-label fallback, truncation, timer formatting, and stale classes.
- Reconciliation throttling and quota-header behavior.
- Preset identity, strict persistence, command ordering, and ambiguous writes.
- Local socket framing, permissions, CLI grammar, and reconnecting watch state.
- Drawer output selection and fixed command/config paths.

### Integration tests

- Worker routing and Durable Object persistence under the local Workers test
  environment.
- WebSocket snapshot delivery, broadcast, heartbeat auto-response, and
  reconnect behavior.
- Client reconciliation against a fake Toggl HTTP server.
- Atomic runtime-state updates consumed by two simultaneous renderers.

### End-to-end development path

One development command starts the local Worker environment, fake Toggl API,
daemon, two renderers, and a real socket watch. Signed fixtures and CLI commands
exercise stop, resume-last, selected resume, webhook echoes, stale confirmation,
an ambiguous create without retry, invalid signatures, and reconnect behavior
while producing real Waybar JSON.

Real-account acceptance then records evidence for:

- normal start and stop propagation, with a target below 10 seconds;
- one-second local timer progression without repeated REST calls;
- correct idle total for the configured timezone;
- suspend/resume recovery;
- explicit stale and offline presentation; and
- exactly one daemon WebSocket with two Waybar renderers.

The latency target is an acceptance target, not a Toggl webhook SLA. Results
must be measured before the README describes the integration as real-time.

## Delivery and operations

GitHub Actions runs formatting, linting, type checking, tests, and secret
scanning on pull requests. After a reviewed change reaches protected `main`,
Cloudflare Workers Builds installs the locked dependencies and runs the
repository's `npm run deploy` command. Cloudflare owns the build credential;
GitHub stores no Cloudflare token or account ID.

Only the production branch is connected. Non-production branch builds are
disabled because Cloudflare does not generate preview URLs for Workers that use
Durable Objects, while GitHub Actions already verifies the complete local path.
Runtime secrets are managed separately in Cloudflare and remain attached across
code deployments.

OS packaging, automatic releases, multi-distribution installation, and a
generalized setup wizard remain deferred. The local installer copies bundled
artifacts to stable XDG paths without enabling services or editing desktop
configuration. Worker code deployment is automated because the production path
and rollback behavior are established.

## References

- [Toggl Track API quotas](https://engineering.toggl.com/docs/track/)
- [Toggl webhook overview and limits](https://engineering.toggl.com/docs/track/webhooks_start/)
- [Toggl webhook event filters](https://engineering.toggl.com/docs/track/webhooks/event_filters/)
- [Toggl webhook signature validation](https://engineering.toggl.com/docs/track/webhooks_start/validating_received_events/)
- [Toggl time entries API](https://engineering.toggl.com/docs/track/api/time_entries/)
- [Cloudflare Durable Object WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
