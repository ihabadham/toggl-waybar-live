# Action-First Toggl Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the existing local Toggl drawer with an action-first Quick Resume list, an expandable Toggl-like Today timeline, and a compact live current-month total without weakening control responsiveness or the API quota reserve.

**Architecture:** Keep Cloudflare and the hosted relay read-only and unchanged. The local daemon enriches webhook state with bounded Toggl REST history, owns Today/month maps, and publishes a strict projection over the existing private Unix socket. One small priority scheduler serializes and paces every local Toggl request; the watch client derives all one-second display changes locally. Eww renders only precomputed display rows and keeps the fixed control surface above a scrollable information region.

**Tech Stack:** TypeScript 7, Node 22+, Vitest 4, Zod 4, Luxon 3, Eww 0.6, Sway/Waybar/systemd.

**Spec:** `docs/superpowers/specs/2026-08-30-action-first-drawer-design.md`

## Execution rules

- Implement production logic first, then add or update the named tests. This is
  the user's explicit workflow choice for this feature.
- Preserve the approved order: current timer, primary action, Quick Resume,
  Today/This Month glance, expandable Today history.
- Keep eight Quick Resume presets as an internal bound; never render `1/8` or
  another capacity counter.
- Reset Today to collapsed on every drawer open.
- Bound Today history by both 50 rows and a 48 KiB projected-frame budget; the
  64 KiB socket limit remains the final fail-closed boundary.
- Drawer open and one-second watch ticks must perform no Toggl request.
- Keep the scheduled-maintenance ceiling at 19 requests per hour: the existing
  18-request worst case plus at most one month read.
- Pace request starts by at least one second. A queued control request takes
  priority over queued background work; do not abort an already-started Toggl
  request and waste its quota.
- Do not add dependencies, a second maintenance lane, Reports API configuration,
  Worker routes, or shared relay protocol fields.
- Never use `git add .`; stage only the files named in each task.
- Never restart Waybar. Only the Toggl daemon and dedicated Eww drawer service
  may be restarted during rollout.

## Task 1: Checkpoint the already-verified drawer runtime foundation

The working tree already contains the Eww service, output mapping, wrapping,
EPIPE, and suspend/duplication hardening that the enriched UI depends on. Keep
that work separate from the new feature.

**Files:**

- `client/src/control-cli.ts`
- `client/src/drawer-controller.ts`
- `client/test/drawer-controller.test.ts`
- `docs/operations.md`
- `docs/setup.md`
- `eww/eww.scss`
- `eww/eww.yuck`
- `scripts/configure`
- `scripts/configure-drawer`
- `scripts/test-install`

- [ ] Inspect the exact baseline diff and confirm no design-plan files are
  accidentally included:

  ```sh
  git status --short
  git diff --check
  git diff --stat
  ```

- [ ] Run the complete existing gate before checkpointing:

  ```sh
  npm run check
  ```

  Expected: build, Biome, TypeScript, Vitest, runtime bundles, and install tests
  all pass with no Waybar restart.

- [ ] Stage only the ten files listed above, review the staged diff, and commit:

  ```sh
  git add client/src/control-cli.ts client/src/drawer-controller.ts \
    client/test/drawer-controller.test.ts docs/operations.md docs/setup.md \
    eww/eww.scss eww/eww.yuck scripts/configure scripts/configure-drawer \
    scripts/test-install
  git diff --cached --check
  git diff --cached --stat
  git commit -m "Harden optional drawer runtime"
  ```

## Task 2: Model month boundaries and local presentation metadata

**Files:**

- Create `client/src/project-color.ts`
- Create `client/src/month-window.ts`
- Modify `client/src/toggl-api.ts`
- Modify `client/src/state.ts`
- Modify `client/src/presets.ts`
- Modify `client/src/preset-file.ts`
- Create `client/test/month-window.test.ts`
- Modify `client/test/toggl-api.test.ts`
- Modify `client/test/state.test.ts`
- Modify `client/test/presets.test.ts`
- Modify `client/test/preset-file.test.ts`

- [ ] Add a single reusable project-color boundary:

  ```ts
  export const projectColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
  export type ProjectColor = z.infer<typeof projectColorSchema>;
  export function projectColor(value: unknown): ProjectColor | null;
  ```

  `projectColor()` returns null for missing or malformed values instead of
  rejecting an otherwise valid time entry.

- [ ] Add month-window helpers beside the existing day-window model:

  ```ts
  export interface MonthWindow {
    monthKey: string;
    start: string;
    end: string;
  }

  export function monthWindowAt(
    instant: string | Date,
    timezone: string,
  ): MonthWindow;

  export function instantBelongsToMonth(
    instant: string,
    window: MonthWindow,
  ): boolean;
  ```

  Use Luxon local `startOf("month")` and next-month boundaries, serialized to
  UTC RFC 3339. Membership is start-inclusive and end-exclusive.

- [ ] Extend `RichTogglEntry` with `projectColor: ProjectColor | null`, parse
  Toggl's `project_color`, and factor the Today list fetch into one private
  bounded-window helper. Add:

  ```ts
  fetchMonth(window: MonthWindow): Promise<ApiResult<RichTogglEntry[]>>;
  ```

  It must use the same `/api/v9/me/time_entries` endpoint, exact `start_date`
  and `end_date`, and `meta=true`; it must return all received entries so the
  coordinator can detect the 1,000-row ceiling.

- [ ] Introduce a client-local entry shape in `state.ts` that adds nullable
  `projectColor` and `taskName` to `NormalizedEntry`. Add the same two fields to
  `CurrentEntry`. Rich REST/local results populate them; narrow relay updates
  preserve known values and use null for unseen entries.

- [ ] Add nullable `projectColor` to `ResumePreset` and `PresetUpdate` display
  metadata. Keep it out of `ResumeActivity`, `canonicalActivity()`,
  `presetIdentity()`, and `activityFromPreset()` so a color change updates the
  row without changing the resumable activity or UUID.

- [ ] Make `presetSchema.projectColor` nullable with a default of null. Confirm
  existing version-one colorless preset files migrate in memory without a file
  version bump.

- [ ] After the logic is in place, add focused tests for:

  - Cairo month boundaries across April and October DST transitions;
  - start-inclusive/end-exclusive month membership and rollover;
  - exact month URL/query construction and 1,000 returned entries;
  - valid and malformed project colors;
  - rich task/color preservation across narrow relay updates;
  - preset color refresh with stable identity/UUID; and
  - loading old colorless preset files as `projectColor: null`.

- [ ] Run the focused gate:

  ```sh
  npm test -w @toggl-waybar-live/client -- \
    test/month-window.test.ts test/toggl-api.test.ts test/state.test.ts \
    test/presets.test.ts test/preset-file.test.ts
  npm run typecheck -w @toggl-waybar-live/client
  ```

- [ ] Stage only this task's files and commit:

  ```sh
  git add client/src/project-color.ts client/src/month-window.ts \
    client/src/toggl-api.ts client/src/state.ts client/src/presets.ts \
    client/src/preset-file.ts client/test/month-window.test.ts \
    client/test/toggl-api.test.ts client/test/state.test.ts \
    client/test/presets.test.ts client/test/preset-file.test.ts
  git diff --cached --check
  git commit -m "Model month history metadata"
  ```

## Task 3: Add bounded Today/month state to the local control protocol

**Files:**

- Create `client/src/month-state.ts`
- Create `client/src/control-snapshot.ts`
- Modify `client/src/control-protocol.ts`
- Modify `client/src/control-server.ts`
- Modify `client/src/control-client.ts`
- Modify `client/src/coordinator.ts`
- Create `client/test/month-state.test.ts`
- Create `client/test/control-snapshot.test.ts`
- Modify `client/test/control-protocol.test.ts`
- Modify `client/test/control-server.test.ts`
- Modify `client/test/control-client.test.ts`
- Modify typed snapshot fixtures in `client/test/control-cli.test.ts`,
  `client/test/drawer-view.test.ts`, and `client/test/coordinator.test.ts`

- [ ] Implement pure month state with independent freshness and completeness:

  ```ts
  export interface MonthState {
    availability: "ready" | "stale" | "unavailable";
    partial: boolean;
    entries: Map<string, NormalizedEntry>;
    monthKey: string;
    synchronizedAt: string | null;
  }
  ```

  Provide `createMonthState`, `advanceMonth`, `applyMonthEntry`,
  `applyMonthRelayMessage`, `replaceReconciledMonthEntries`,
  `markMonthRefreshFailed`, and `completedMonthSeconds`. Rollover clears the map,
  sync time, and partial flag. A failed refresh preserves entries and partial;
  it is `stale` only when a prior synchronized value exists, otherwise
  `unavailable`.

- [ ] Extend the strict local protocol with:

  ```ts
  interface ControlTodayEntry {
    id: string;
    description: string;
    projectId: string | null;
    projectName: string | null;
    projectColor: ProjectColor | null;
    taskName: string | null;
    start: string;
    stop: string | null;
    durationSeconds: number | null;
  }

  interface ControlMonthProjection {
    availability: "ready" | "stale" | "unavailable";
    partial: boolean;
    key: string | null;
    completedSeconds: number;
    currentContributes: boolean;
    synchronizedAt: string | null;
  }
  ```

  Add `timezone: string | null`, `todayEntries`, `todayEntryCount`,
  `todayEntriesOmitted`, and `month` to `ControlSnapshot`; add nullable task/color
  to current and nullable color to presets. Refine the schema so visible plus
  omitted rows equals the total count and visible rows never exceed 50. Validate
  non-null timezones by constructing `Intl.DateTimeFormat` with the value. A
  null timezone is valid only for the offline daemon-unavailable shape with no
  current/Today rows and an unavailable month.

- [ ] Export `maximumControlFrameBytes = 64 * 1024` and a UTF-8 frame-size helper
  from `control-protocol.ts`. Reuse that constant in both socket peers instead of
  maintaining duplicate literals. Size the exact JSON frame including its
  trailing newline.

- [ ] Build `control-snapshot.ts` around:

  ```ts
  export const maximumProjectedControlSnapshotBytes = 48 * 1024;
  export function chronologicalTodayEntries(
    state: ClientState,
  ): ControlTodayEntry[];
  export function boundedControlSnapshot(
    base: ControlSnapshotBase,
    entries: readonly ControlTodayEntry[],
    maximumBytes?: number,
  ): ControlSnapshot;
  ```

  Union the qualifying current entry by ID, sort newest-first with a stable ID
  tie-breaker, keep repeated descriptions as separate rows, and append complete
  labels one row at a time until either 50 rows or the 48 KiB serialized-frame
  budget is reached. Report every omitted earlier row; never truncate labels.

- [ ] Give `ClientCoordinator` an initial current-month state, apply relay and
  successful local create/stop/delete changes to it, and rotate day plus month
  through `advanceCalendar()`. Project the month as unavailable until Task 4's
  first REST month reconciliation, but preserve locally observed entries.

- [ ] Expand the daemon-unavailable client snapshot with null timezone, empty
  Today rows/counts, and an unavailable month. Update every typed fixture to the
  new closed schema; do not loosen schema strictness.

- [ ] After implementation, cover:

  - month replacement, local/webhook merge/delete, rollover, stale preservation,
    and partial-plus-stale preservation;
  - newest-first Today sorting, repeated segments, current union, 50-row cap,
    multibyte UTF-8 byte budgeting, full labels, and omission accounting;
  - strict timezone/Today/month parsing and unavailable fallback;
  - the shared 64 KiB socket rejection behavior; and
  - all updated typed snapshot fixtures.

- [ ] Run:

  ```sh
  npm test -w @toggl-waybar-live/client -- \
    test/month-state.test.ts test/control-snapshot.test.ts \
    test/control-protocol.test.ts test/control-server.test.ts \
    test/control-client.test.ts test/coordinator.test.ts \
    test/control-cli.test.ts test/drawer-view.test.ts
  npm run typecheck -w @toggl-waybar-live/client
  ```

- [ ] Stage only this task's files and commit:

  ```sh
  git add client/src/month-state.ts client/src/control-snapshot.ts \
    client/src/control-protocol.ts client/src/control-server.ts \
    client/src/control-client.ts client/src/coordinator.ts \
    client/test/month-state.test.ts client/test/control-snapshot.test.ts \
    client/test/control-protocol.test.ts client/test/control-server.test.ts \
    client/test/control-client.test.ts client/test/control-cli.test.ts \
    client/test/drawer-view.test.ts client/test/coordinator.test.ts
  git diff --cached --check
  git commit -m "Bound local drawer history snapshots"
  ```

## Task 4: Serialize Toggl traffic and reconcile the month within quota

**Files:**

- Create `client/src/toggl-request-scheduler.ts`
- Modify `client/src/coordinator.ts`
- Modify `client/src/daemon.ts`
- Create `client/test/toggl-request-scheduler.test.ts`
- Modify `client/test/coordinator.test.ts`
- Modify `client/test/daemon.test.ts`
- Modify `client/test/quota-gate.test.ts`

- [ ] Implement one small scheduler owned by the daemon/coordinator boundary:

  ```ts
  export type BackgroundRequestResult<T> =
    | { status: "completed"; value: T }
    | { status: "skipped" };

  export interface CoordinatorRequestScheduler {
    runControl<T>(operation: () => Promise<T>): Promise<T>;
    runBackground<T>(
      operation: () => Promise<T>,
      stillRelevant: () => boolean,
    ): Promise<BackgroundRequestResult<T>>;
    drain(): Promise<void>;
  }
  ```

  The production scheduler permits one in-flight operation, spaces request
  starts by at least 1,000 ms, is FIFO within each priority, and chooses queued
  control work before queued background work. Check `stillRelevant` immediately
  before starting queued background work and skip it without consuming quota if
  a mutation/revision made it obsolete. Re-evaluate queue priority after any
  pacing wait so a control that arrives during the wait goes first. Do not cancel
  an active HTTP request; an arriving control waits for at most that one existing
  10-second-bounded request, then runs before any remaining background work.

- [ ] Route every coordinator API operation through the scheduler. Scheduled
  Today/current/month reads use `runBackground`; command confirmation, relay
  conflict confirmation, create, stop, and their follow-up current checks use
  `runControl`. Keep quota-header recording for every request that actually
  starts, even when its eventual state result is stale.

- [ ] Change reconciliation to return `"completed" | "skipped" | "failed"` so
  a mutation that supersedes background work does not produce a false warning.
  Execute full reconciliation in this exact order:

  1. Today background read and quota record.
  2. Current background read and quota record, at least one second after Today's
     start.
  3. Validate captured timer/mutation/relay revisions.
  4. Commit core Today/current state, merge those rich entries into current-month
     state, and refresh presets.
  5. If the month is due and the quota reserve allows it, enqueue one month read.
  6. On success, replace month state, merge the already-fetched current entry
     when its start belongs to the month, and mark `partial` when the raw result
     length is at least 1,000.
  7. On month failure, preserve the prior total/partial flag and mark month
     stale or unavailable without changing the successful core outcome or
     global command error.

- [ ] Track `lastMonthAttemptAt` when the month callback actually starts and
  `monthRefreshRequested` on startup, local rollover, and real connection-state
  edges. Require a full hour since the preceding started month request even
  after rollover/reconnect. Opening the drawer never affects this state.

- [ ] Keep `QuotaGate.nextAction()` as the existing `full | current | none`
  schedule. Include `allowsRequest()` in every queued background relevance check
  so a control request's newer quota headers can suppress work that has not yet
  started. Recheck it before the optional month read. Do not add a month
  maintenance action or freshness state to the gate.

- [ ] Construct the scheduler in `daemon.ts`, pass it into the coordinator,
  call `advanceCalendar()` from the existing 30-second maintenance callback,
  log only a `failed` reconciliation, and include scheduler completion in
  `coordinator.drain()`.

- [ ] After the logic, add deterministic fake-clock tests for:

  - maximum concurrency one and request-start gaps of at least 1,000 ms;
  - FIFO within priority and control precedence over queued background work;
  - a control arriving during pacing taking the next start;
  - obsolete queued background work skipping without invoking its callback;
  - no cancellation of active control/background calls and complete draining;
  - full order Today -> current -> month with no overlap;
  - startup and one-hour month refresh, reconnect/rollover due flags that do not
    bypass the hourly guard, and quota-reserve skip;
  - optional month failure preserving a successful core reconciliation;
  - webhook/local changes winning over stale month results;
  - expected command supersession producing `skipped`, not a warning; and
  - six full pairs, six disconnected current reads, and one month read totaling
    19 scheduled maintenance requests in the worst-case hour.

- [ ] Run:

  ```sh
  npm test -w @toggl-waybar-live/client -- \
    test/toggl-request-scheduler.test.ts test/coordinator.test.ts \
    test/quota-gate.test.ts test/daemon.test.ts
  npm run typecheck -w @toggl-waybar-live/client
  npm run build -w @toggl-waybar-live/client
  ```

- [ ] Stage only this task's files and commit:

  ```sh
  git add client/src/toggl-request-scheduler.ts client/src/coordinator.ts \
    client/src/daemon.ts client/test/toggl-request-scheduler.test.ts \
    client/test/coordinator.test.ts client/test/daemon.test.ts \
    client/test/quota-gate.test.ts
  git diff --cached --check
  git commit -m "Reconcile month totals within quota"
  ```

## Task 5: Project the live action-first drawer view

**Files:**

- Modify `client/src/drawer-view.ts`
- Modify `client/src/control-cli.ts`
- Modify `client/test/drawer-view.test.ts`
- Modify `client/test/control-cli.test.ts`

- [ ] Replace the minimal drawer projection with primitive display fields for:

  - current label/context/color/live elapsed;
  - Quick Resume label/context/color/play-ready rows;
  - Today total, entry count, chronological rows, and omitted-row copy; and
  - month value, availability, and cue.

  Keep raw labels as data, never command fragments. Compose context as
  `project · task` without duplicates. Use a schema-validated project color or
  the fixed muted fallback.

- [ ] Format ranges with one `Intl.DateTimeFormat("en-GB", { timeZone,
  hour: "2-digit", minute: "2-digit", hourCycle: "h23" })` per projection.
  Render completed rows as `start – stop`, running rows as `start – Now`, and
  derive missing completed duration from stop minus start.

- [ ] Reuse the current elapsed value to advance the current timer, Today total,
  running Today row, and month total locally. Month formatting uses whole hours
  and two-digit minutes with no seconds. Implement all states:

  | Freshness/completeness | Value | Cue |
  | --- | --- | --- |
  | unavailable | `—` | none |
  | ready, complete | `78h 24m` | none |
  | ready, partial | `≥ 78h 24m` | `partial` |
  | stale, complete | `78h 24m` | `stale` |
  | stale, partial | `≥ 78h 24m` | `partial · stale` |

- [ ] Preserve snapshot ordering; sorting and byte bounds belong only to
  `control-snapshot.ts`. Emit complete non-null strings/booleans for each dynamic
  row so Eww row widgets never need the global subscription or null checks.

- [ ] Keep `control-cli watch` on one socket subscription and one local
  one-second projection timer. Add no config read, socket reconnect beyond the
  existing watcher, command dispatch, or network call to each tick. Preserve
  coalesced backpressure handling and EPIPE behavior.

- [ ] After implementation, test:

  - one tick advancing current, Today, running row, and month together;
  - completed repeated descriptions staying separate and stable;
  - configured-zone range formatting across DST;
  - project/task context, safe muted color fallback, and hostile labels;
  - singular/plural omitted-row copy;
  - all five month rendering combinations; and
  - one watch subscription with no command sender invoked during ticks.

- [ ] Run and commit:

  ```sh
  npm test -w @toggl-waybar-live/client -- \
    test/drawer-view.test.ts test/control-cli.test.ts
  npm run typecheck -w @toggl-waybar-live/client
  git add client/src/drawer-view.ts client/src/control-cli.ts \
    client/test/drawer-view.test.ts client/test/control-cli.test.ts
  git diff --cached --check
  git commit -m "Project live drawer history"
  ```

## Task 6: Build, document, and roll out the approved Eww drawer

**Files:**

- Modify `client/src/drawer-controller.ts`
- Modify `client/test/drawer-controller.test.ts`
- Modify `eww/eww.yuck`
- Modify `eww/eww.scss`
- Modify `scripts/test-install`
- Modify `README.md`
- Modify `docs/design.md`
- Modify `docs/write-controls.md`
- Modify `docs/operations.md`
- Modify `docs/setup.md` only if the installed interaction/setup text needs a
  corresponding correction

- [ ] Add `today_expanded=false` to the Eww open path before creating/revealing
  the window. A reset failure must stop the open and report
  `Unable to reset the Today disclosure`; toggle-to-open uses the same path.

- [ ] Rebuild `eww.yuck` around fixed heading/current/primary controls followed
  by one scroll containing Quick Resume, the Today/This Month glance, and Today
  history. Specifically:

  - define `today_expanded false` and reset it through the controller;
  - replace `RECENT` with `QUICK RESUME` and remove all `/8` copy;
  - add a right-aligned play affordance to every Quick Resume row;
  - keep Quick Resume visible but disable its static parent while running;
  - make the Today glance a local `EWW_CMD update` toggle;
  - reveal the timeline with a 150 ms `slidedown` transition;
  - render one row per `toggl_view.todayEntries` item and the omitted-row copy;
  - ensure the dynamic Today and preset row widgets reference only their row
    argument, never `toggl_view` or `today_expanded`; and
  - keep the existing 720-pixel panel, full label wrapping, transparent backdrop,
    keyboard-neutral window, and separate Eww service.

- [ ] Translate the approved visual hierarchy into GTK-compatible SCSS using
  the existing earthified Toggl palette: current card, primary button, Quick
  Resume rows, play affordance, two-column glance, timeline connector, color
  markers, right-aligned ranges/durations, omitted count, and a quiet scrollbar.
  Do not port browser-only grid/flex/media/transform rules. Apply dynamic colors
  only from the validated projection.

- [ ] Extend controller/source/install tests to prove:

  - disclosure reset precedes open and a reset failure creates no window;
  - `QUICK RESUME`, Today toggle/revealer, vertical scroll, and full initial JSON
    exist;
  - `RECENT`, `/8`, unresolved placeholders, direct null comparisons,
    `:limit-width`, and unsupported font weights do not exist;
  - every label keeps `:show-truncated false`;
  - `preset-row` and `today-entry-row` do not capture global Eww state;
  - installed assets retain the same contracts; and
  - existing pinned Node/Eww, compositor socket, permissions, checksums, and
    no-package-manager guarantees remain intact.

- [ ] Update public documentation with only behavior users/operators need:

  - README: action-first drawer summary;
  - design/write-controls: local Today/month projection, request scheduler,
    start-time calendar membership, partial/stale treatment, and no relay change;
  - operations: 19-request scheduled-maintenance ceiling, month failure behavior,
    and drawer diagnostics; and
  - setup: Quick Resume/Today disclosure interaction if the existing setup text
    would otherwise be misleading.

- [ ] Run the complete automated gate:

  ```sh
  npm run check
  git diff --check
  ```

- [ ] Record the existing Waybar processes, install the verified local bundles,
  and restart only the two dedicated services:

  ```sh
  pgrep -a waybar
  ./scripts/configure
  ./scripts/configure-drawer
  systemctl --user daemon-reload
  systemctl --user restart toggl-waybar-live.service toggl-waybar-drawer.service
  systemctl --user --no-pager --full status \
    toggl-waybar-live.service toggl-waybar-drawer.service
  journalctl --user -u toggl-waybar-live.service \
    -u toggl-waybar-drawer.service -n 80 --no-pager
  pgrep -a waybar
  ```

  Expected: both services are active, no repeated Eww/daemon error appears, and
  the before/after Waybar process list is identical. Do not run a Waybar restart
  or reload command.

- [ ] Manually verify on both outputs:

  - idle and running current cards;
  - Stop, Resume Last, and selected Quick Resume;
  - Quick Resume disabling/enabling around Stop;
  - Today expand/collapse, reset-on-open, repeated chronological rows, running
    `Now`, live totals, and omitted-row copy when supplied by a fixture;
  - exact, stale, unavailable, partial, and partial-plus-stale month treatments
    through automated fixtures plus the live exact state;
  - lower-region scrolling on the shorter output;
  - suspend/resume reconciliation; and
  - exactly one Scroll-owned Waybar process with no duplicate bar.

- [ ] Stage only the changed UI, test, and documentation files, inspect the full
  staged diff, and commit:

  ```sh
  git add client/src/drawer-controller.ts client/test/drawer-controller.test.ts \
    eww/eww.yuck eww/eww.scss scripts/test-install README.md \
    docs/design.md docs/write-controls.md docs/operations.md
  if ! git diff --quiet -- docs/setup.md; then git add docs/setup.md; fi
  git diff --cached --check
  git diff --cached --stat
  git commit -m "Enrich the action-first Toggl drawer"
  ```

- [ ] Finish with repository and live-state evidence:

  ```sh
  npm run check
  git status --short --branch
  git log --oneline --decorate -8
  systemctl --user is-active toggl-waybar-live.service toggl-waybar-drawer.service
  pgrep -a waybar
  ```

  Expected: checks pass, the feature branch is clean, both services are active,
  and Waybar remains a single unchanged process.
