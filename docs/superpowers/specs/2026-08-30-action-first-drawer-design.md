# Action-first drawer enrichment

Status: proposed for implementation; visual direction approved

## Context

The existing Eww drawer has the correct interaction boundary: it is a fast,
local control surface for the current Toggl timer and resumable activities. Its
visual treatment is polished, but the information model exposes only the
current entry, today's aggregate total, and a list labeled `RECENT` with an
internal `1/8` capacity counter.

That makes two concepts hard to interpret:

- `RECENT` is a list of distinct resumable activity templates, not raw time
  entries or chronological history.
- `1/8` means one cached preset out of an implementation limit of eight. It is
  not a position, page count, or count of today's entries.

The redesign must remain action-first. It should borrow Toggl Track's familiar
row grammar so the user does not need to interpret two unrelated interfaces,
without recreating Toggl's reports or turning the drawer into a dashboard.

## Goals

- Preserve Stop, Resume Last, and selected resume as the drawer's primary job.
- Rename `RECENT` to `QUICK RESUME` and remove the internal capacity counter.
- Make quick-resume rows visually consistent with Toggl time-entry rows while
  retaining an obvious play affordance.
- Show today's total and entry count at a glance.
- Reveal a chronological Today entry list only on request.
- Show one compact current-calendar-month total without report navigation or
  filters.
- Keep live timer, Today, and month values advancing locally without 1 Hz
  daemon, socket, or Toggl traffic.
- Keep controls responsive when history or month data is stale or unavailable.

## Non-goals

- Replacing the Toggl web or desktop application.
- Adding report charts, grouping, filters, targets, or project breakdowns.
- Editing, deleting, or creating arbitrary time-entry details.
- Changing the Cloudflare relay into a writable or historical service.
- Adding a Reports API dependency or new required workspace/user configuration.
- Making informational refreshes a prerequisite for Stop or Resume.

## User experience

### Action hierarchy

The drawer keeps this order:

1. Toggl heading and connection status.
2. Current timer card with live duration and project context.
3. One prominent state-aware primary action: Stop Timer or Resume Last.
4. `QUICK RESUME`, containing distinct resumable activities.
5. A compact glance row for Today and This Month.
6. Today's chronological entries, hidden until Today is expanded.

The current timer and primary action remain fixed above the secondary content.
The lower content may scroll on shorter outputs. Opening informational details
must never move the primary action out of its stable position.

While a timer is running, quick-resume rows remain visible but disabled. Stop
keeps the drawer open and immediately enables them. While idle, selecting a
quick-resume row starts that activity and closes the drawer, matching the
existing control behavior.

### Familiar Toggl row grammar

Current, quick-resume, and Today rows share the same visual vocabulary:

- description is the primary label;
- project and optional task context sit beneath it;
- a small project-color marker precedes project context when metadata exists;
- time range and duration align to the right for chronological entries; and
- the running entry uses the existing earthified Toggl accent and `Now`.

The drawer keeps the current earthy palette. It uses Toggl-provided project
colors when available and a muted theme fallback when they are not. Missing
metadata must not delay or hide an entry.

### Quick Resume

`QUICK RESUME` remains the main list. Each row represents one exact reusable
activity identity: workspace, description, project, task, tags, and billable
state. It is not a time-entry-history row.

The `1/8` label is removed. Eight remains an internal storage and payload bound,
not user-facing copy. Empty state copy explains that resumable activities
appear after Toggl synchronizes.

### Today disclosure

The collapsed Today control shows:

```text
TODAY  02:59:56  ·  5 entries  ⌄
```

It is reset to collapsed whenever the drawer opens. Clicking it expands an
in-place list ordered newest first. Each recorded segment remains a separate
row, including repeated descriptions, matching Toggl's chronological model.
Each row shows:

- description;
- project name and color when known;
- local `start – stop`, or `start – Now` for the running entry; and
- that entry's duration.

The running row and totals tick locally once per second. Completed rows remain
stable. Collapsing Today returns immediately to the action-focused layout.

The control snapshot carries the total count and packs at most the newest 50
rows within a conservative serialized-byte budget. Both limits protect the
private 64 KiB socket protocol; the row limit alone is not assumed to bound
arbitrarily long user text. Included labels remain complete. If the remaining
frame budget or row limit omits entries, the drawer identifies how many earlier
rows are absent instead of silently claiming the visible list is complete.

### This Month glance

The adjacent compact metric shows the total for the configured local calendar
month across the user's accessible workspaces:

```text
THIS MONTH
78h 24m
```

It uses hour-and-minute precision because it is a glance metric, not an active
timer. A running entry that belongs to the current month advances the value
locally. The metric does not expand into a report and does not displace Quick
Resume.

## Data model and protocol

### Today entries

The daemon already owns today's entry map. The local control protocol and its
unavailable fallback snapshot add a strict `todayEntries` projection,
`todayEntryCount`, and `todayEntriesOmitted`. A row contains only the fields the
view needs:

- entry ID;
- description;
- nullable project ID, name, and color;
- start timestamp;
- nullable stop timestamp; and
- nullable completed duration.

Rows are sorted newest first before applying the 50-row view bound. The existing
completed-today base and `currentContributesToToday` fields remain the source
for the live aggregate total.

Project color is client-local presentation metadata. Rich REST responses may
populate it; narrow relay changes preserve already-known metadata and use a
null fallback for unseen entries. The hosted relay protocol remains unchanged.
Resume preset identity does not include project color because color changes do
not create a different resumable activity.

### Month state

The daemon owns a separate in-memory current-month entry map keyed by entry ID.
It exposes only a compact month projection through the control snapshot:

- completed month seconds;
- whether the current running entry contributes to this month;
- month key;
- synchronization timestamp; and
- availability: `ready`, `stale`, `partial`, or `unavailable`.

The drawer never receives the full month history. This keeps the local protocol
small and makes the month feature explicitly subordinate to controls.

### Month source and refresh

The initial implementation uses the existing authenticated
`GET /api/v9/me/time_entries` endpoint with explicit RFC 3339 bounds for local
month start and next-month start. This choice:

- works across the user's workspaces;
- needs no additional local configuration;
- includes running entries; and
- reuses the existing API token, parser, quota accounting, and timezone model.

The endpoint's 1,000-entry response ceiling is treated explicitly. A response
at the ceiling cannot be assumed complete; the state becomes `partial` and the
UI does not present a falsely exact total. Reports v3 can become a future
fallback if real usage requires it, but is not introduced now because it is
workspace-specific, needs additional user scoping, and does not include the
active running duration.

Month reconciliation is an optional part of the existing full-reconciliation
path rather than a third maintenance lane. It has an independent one-hour
freshness deadline. A full reconciliation performs the required Today and
current reads first, then performs the month read only when that deadline or a
month-key change makes it due and quota remains available. A month failure does
not turn an otherwise successful core timer reconciliation into a failure.

Month reconciliation becomes due:

- once at daemon startup when quota permits;
- at local month rollover;
- after a meaningful relay gap, reconnect, or resume from suspend; and
- at most once per hour as a quiet correctness backstop.

Opening the drawer does not synchronously fetch month data. It immediately
shows the latest memory state. Webhook create/update/delete events and successful
local Stop/Resume results update both Today and month maps between REST
reconciliations. The running contribution is computed in the watch client once
per second from the base snapshot.

All Toggl requests continue through the shared quota gate. Background Today,
current, and optional month reads are serialized and paced according to
Toggl's safe request guidance rather than issued concurrently. User-triggered
writes keep priority over background information refreshes. The existing
ten-minute full and alternating five-minute disconnected-current schedule
therefore remains intact. Its worst-case background budget rises from 18 to at
most 19 requests per hour: twelve Today/current full reads, six disconnected
current reads, and one month read. This retains an eleven-request reserve below
the documented 30-request user quota before user-triggered writes.

## Failure behavior

- Stop and Resume depend only on trusted current timer state, never on Today
  disclosure or month availability.
- Offline or stale state retains the last trusted Today rows and month total,
  with the existing connection treatment making staleness visible.
- Before the first successful month read, the metric shows an em dash rather
  than zero.
- A partial 1,000-entry month response is rendered with a `≥` prefix and a
  `partial` cue, never as an exact total.
- A failed month refresh preserves the prior value, marks it stale, and waits
  for the normal retry schedule; it does not create a tight retry loop.
- Corrupt or oversized local control messages retain the existing fail-closed
  socket behavior.
- Missing project color, task, or other display metadata falls back gracefully
  without affecting duration correctness.

## Verification

Automated verification covers:

- strict parsing and unavailable fallbacks for Today rows and the month
  projection;
- newest-first Today sorting, separate repeated segments, the 50-row ceiling,
  and byte-budget omission accounting;
- local time-range and duration formatting, including running `Now` rows;
- local day and month boundaries in the configured timezone, including DST;
- month bootstrap, webhook merge, local Stop/Resume merge, rollover, and stale
  refresh behavior;
- the 1,000-entry partial-month guard;
- quota reservation, optional month reads inside full reconciliation, the
  19-request ceiling, and serialized background reads;
- no network request when the drawer opens or ticks;
- `QUICK RESUME` copy and absence of the `1/8` implementation counter;
- disclosure rendering without dynamic-row global subscriptions, preserving
  the existing Eww scope-bug regression coverage; and
- Eww asset/install compatibility.

Manual verification covers:

- running and idle action states;
- Stop followed by selected resume;
- Today expand/collapse and live ticking;
- month display before, during, and after a running entry;
- narrow-height scrolling and the existing 720-pixel width on both outputs;
- suspend/resume reconciliation; and
- exactly one Scroll-owned Waybar process before and after drawer testing.

Manual rollout must not restart Waybar. The dedicated Eww drawer service and
Toggl daemon may be restarted independently after their installed bundles are
updated.
