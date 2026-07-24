# ADR 0017: Unified Request Event Journal

## Status

Proposed (2026-07-24). Draft for review; nothing here is implemented.

## Rules at a glance

Normative summary of the proposal; contracts and rationale below.

- One **event catalog** (`src/contracts/events.ts`) is the single declaration site for every
  diagnostic/telemetry event kind: key, subsystem, default level, and derivation traits. Emitting a
  kind not in the catalog is a compile error; consumers derive kind sets from traits, never from
  parsing kind names.
- One **journal** per request scope is the single append point (`emitDiagnostic` evolves into it).
  Emitters state facts; they never know who is listening. There is no `EventEmitter`, no dynamic
  subscription.
- Every consumer is a **sink**: an explicitly registered, statically enumerable projection of the
  journal (debug ndjson, session event log, progress wire stream, replay timing trace, agent-cost
  tally). Sinks filter by kind/trait and own their output format.
- **Wire and file formats do not change.** `events.ndjson` v1 entries, progress envelopes, the
  `replay-timing.ndjson` shape, `cost.runnerRoundTrips`, and per-request
  `sessions/<name>/requests/<id>.ndjson` stay byte-compatible; golden fixtures gate this.
- **Redaction happens once, at the journal boundary.** Every event is redacted on append; sinks
  write pre-redacted events and add no second pass.
- The journal is an observability spine, **not** a source of truth: `session.actions` and all other
  session state remain owned by their stores. No state is ever rebuilt from journal events.

## Context

The codebase has grown four parallel event vocabularies, each with its own emit call, shape,
redaction discipline, and sink (inventoried 2026-07-24):

1. **Diagnostics** (`src/utils/diagnostics.ts`). ~155 distinct stringly-typed `phase` values across
   ~70 files, an `AsyncLocalStorage` request scope entered in exactly three places (CLI pre-parse,
   daemon per-request in `request-router.ts`, daemon fatal catch-all), an in-memory buffer plus a
   `phaseCounts` tally, and debug-mode live streaming to the per-request ndjson file (after
   `createRequestExecutionScope` rebinds `logPath`), `daemon.log`, or stderr. The
   `traceLogPath` scope option is dead: no call site ever sets it.
2. **Session event log** (`src/daemon/session-event-log.ts`). Append-only per-session
   `events.ndjson` with kinds `request.started`/`request.finished`/`action.recorded`, written from
   three lifecycle points plus `SessionStore.recordAction`, read only by the public `events`
   command. `action.recorded` is already a projection of `session.actions` pushes — the model this
   ADR generalizes.
3. **Progress streaming** (`src/request/progress.ts`, `src/daemon/request-progress-protocol.ts`).
   A typed `RequestProgressEvent` union emitted through a single-sink `AsyncLocalStorage`,
   serialized as ndjson envelopes multiplexed onto the same socket/HTTP response stream as the
   final response. Opt-in per request via `meta.requestProgress`; disabled under `--json`.
4. **Replay timing trace** (`src/daemon/handlers/session-replay-trace.ts`,
   `session-test-runtime.ts`, read by `src/replay/test/trace.ts`). Per-attempt
   `replay-timing.ndjson` with `replay_action_start/stop` and attempt-lifecycle events — written by
   **two different helpers, one of which redacts and one of which does not**
   (`appendReplayTraceEvent` vs `appendReplayTestTimingEvent`).

(`src/upload-progress.ts` is a fifth, local-only callback sink for artifact uploads; it never
crosses the request scope and is out of scope here. Production code contains no `EventEmitter`
usage at all — the codebase already avoids implicit pub/sub, which this design preserves.)

The channels overlap (a request start is an event in at least two of them) but share nothing: no
common envelope, no shared kind vocabulary, and consumers couple to emit sites by string. The
sharpest instance: agent-cost's `runnerRoundTrips` is `countDiagnosticEventsByPhase(['ios_runner_command_send',
'ios_runner_readiness_preflight'])` (`src/daemon/request-router.ts`) — a hand-picked name list a new
runner phase can silently drift from. That violates two established repo rules: *what enumerates
N?* (nothing enumerates round-trip phases), and *categories come from recorded fields, never parsed
names*.

ADR 0008 solved the same shape of problem for commands: one declaration registry, behavior derived
by parity-tested projection. This ADR applies that thesis to events.

## Decision

### 1. Event catalog: kinds are declared data

`src/contracts/events.ts` exports one `EVENT_CATALOG` — a const object with one entry per event
kind, keyed by today's phase strings (no renames in this ADR):

```ts
type EventDescriptor = {
  /** Grouping for docs/filtering; not parsed from the kind name. */
  subsystem: 'apple-runner' | 'android' | 'daemon' | 'request' | 'record' | 'replay'
    | 'snapshot' | 'cli' | 'web' | 'compat' | 'util';
  level: 'info' | 'warn' | 'error' | 'debug';
  /** Derivation traits — the only way a consumer may select kind sets. */
  traits?: readonly EventTrait[]; // e.g. 'runner-round-trip', 'progress', 'session-lifecycle'
};

type EventKind = keyof typeof EVENT_CATALOG;
```

`emitDiagnostic`'s `phase` parameter narrows from `string` to `EventKind`, making every
uncataloged emit a compile error — the same completeness mechanism as the ADR 0011 matrix. The
existing ~155 phases enter the catalog verbatim; per-kind `data` payloads stay
`Record<string, unknown>` in this ADR (typed payload schemas are a possible follow-up, not a
requirement — see Alternatives).

Consumers derive kind sets from traits: `RUNNER_ROUND_TRIP_PHASES` becomes
`kindsWithTrait('runner-round-trip')` (exactly `ios_runner_command_send` and
`ios_runner_readiness_preflight` carry the trait; their `_skipped`/`_recovered` variants
deliberately do not, preserving today's cost semantics). A parity test pins the derived sets so a
trait edit is a reviewed decision, not a drift.

The catalog lives in `contracts` (ranked, kernel-adjacent) so every zone — including unranked
peripherals and `utils` — may import it without a layering back-edge. The journal runtime evolves
in place in `src/utils/diagnostics.ts`, keeping all existing import directions legal.

### 2. One journal, explicit sinks

The diagnostics scope becomes the **request journal**: the single append point for every event in
the four vocabularies. `emit(event)` does exactly what `emitDiagnostic` does today — stamp the
scope envelope (`ts`, `requestId`, `session`, `command`), redact `data`, buffer, tally
`phaseCounts` — and then offers the event to each registered sink.

Sinks are constructed with the scope (daemon request entry, CLI entry, fatal scope) and listed in
one place per entry point — statically enumerable, greppable, no dynamic subscription API:

- **debug stream sink** — today's debug-mode live ndjson writer (per-request file / `daemon.log` /
  stderr fallback), unchanged behavior including the `liveWrittenEventCount` flush watermark;
- **session event log sink** — consumes the `session-lifecycle` trait kinds
  (`request.started`/`request.finished`/`action.recorded`) and writes today's `events.ndjson` v1
  entries, reusing the existing presentation builders (`buildActionSummary`,
  `buildRequestSuccessEventPresentation`) and per-path write queue;
- **progress sink** — consumes `progress`-trait kinds and forwards to the existing wire envelope
  serializer when `meta.requestProgress` opted in; the `RequestProgressEvent` union becomes the
  `data` payload of those kinds, and `src/request/progress.ts`'s separate `AsyncLocalStorage`
  is retired in favor of the journal scope;
- **replay trace sink** — consumes replay-trace kinds and writes the per-attempt
  `replay-timing.ndjson`, replacing both existing append helpers (closing the unredacted
  `appendReplayTestTimingEvent` gap for free);
- **agent-cost tally** — already a projection (`phaseCounts`); now reads its kind set from the
  `runner-round-trip` trait.

The lifecycle points that today call `sessionStore.recordEvent`/`appendActionEvent` directly
(`request-execution-scope.ts`, `request-router.ts`, `session-store.ts`) instead `emit` the
corresponding journal kinds; the sink owns the file. `SessionAction` recording itself is untouched:
`recordActionEntry` still pushes to `session.actions` first, and the `action.recorded` journal
event remains a projection of that push.

### 3. Invariants

- **Byte compatibility.** Every existing output — `events.ndjson` v1, progress envelopes and their
  transport framing, `replay-timing.ndjson` event shapes, per-request diagnostics ndjson,
  `cost.runnerRoundTrips` — is produced identically by the sinks. Golden fixtures under
  `contracts/fixtures/` pin each format (the parity-table pattern).
- **Single redaction boundary.** `redactDiagnosticData` runs once, on append. The flush path's
  second whole-entry pass is retained only until sinks own their writes, then removed. No sink may
  write an event that did not pass through the journal.
- **Emitters never branch on consumers.** An emit site must not know or care whether debug mode,
  progress streaming, or a replay trace is active. Anything consumer-conditional lives in the sink.
- **No state from events.** The journal is write-only telemetry. Recovering session state, replay
  provenance, or repair watermarks from journal events is out of scope and rejected (see
  Alternatives).
- **Traits over names.** No production code may select events by matching kind-name substrings
  (`startsWith('ios_runner_')` etc.); a lint-style test enforces this for the derived-set helpers.

## Consequences

- Traceability becomes "filter the journal by `requestId`": one envelope, one ordering, across what
  are today four files with three envelope shapes.
- New observability features (a timeline command, an OTel exporter, a perf-phase report) are new
  sinks — no new emit sites, no new vocabularies.
- Adding an event kind is a catalog entry plus emit sites; forgetting the catalog is a compile
  error. Renaming a kind is a visible, reviewable catalog diff (kinds are wire-visible in debug
  ndjson, so renames are breaking for log consumers and need the same care as today).
- The dead `traceLogPath` option, the duplicate redaction pass, and the unredacted replay-timing
  helper are deleted.
- Cost: a mechanical, wide migration (~70 files import the typed kind; the string values
  themselves do not change, so diffs are type-level). Runtime overhead is one sink-dispatch loop
  per event over today's buffer push — negligible against device I/O.

## Alternatives considered

- **One closed discriminated union with typed payloads per kind (full event-sourcing typing):**
  rejected for this ADR — 155 kinds × payload schemas is a large, low-yield migration, and payload
  types can be added per-kind incrementally once the catalog exists. The catalog is the enforcement
  point; payload typing is a follow-up, not a prerequisite.
- **`EventEmitter`/pub-sub bus:** rejected. Implicit subscription defeats both goals: deletability
  (who listens is not statically visible) and traceability (causality disappears into `.on()`).
  The codebase currently has zero production `EventEmitter` usage; this design keeps it that way.
- **Event sourcing (rebuild session state from the journal):** rejected. Session state has owners
  (`SessionStore`, ref frames, repair transactions) with their own invariants and gates; deriving
  it from telemetry would couple correctness to an observability channel and is a large behavioral
  rewrite with no user-facing benefit.
- **Leave the four channels, just type the phases:** considered as a stopping point — step 1 alone
  fixes the stringly agent-cost coupling — but it leaves the duplicate envelopes, the redaction
  inconsistency, and four write paths. Kept as the migration's first independently useful step
  instead.
- **Merge `upload-progress` and `app-events` in:** rejected. Upload progress is a local
  byte-counter callback that never crosses the request scope; `core/app-events.ts` is a deep-link
  builder for the `trigger-app-event` command, not an event channel. Neither shares the journal's
  envelope or consumers.

## Validation required for implementation

- Type-level completeness: an emit with an uncataloged kind fails to compile; a test enumerates the
  catalog against the set of kinds actually emitted in a full unit-suite run and fails on
  uncataloged or orphaned (declared-but-never-emitted) kinds, with an explicit allowlist for
  rare-path kinds.
- Golden byte-compatibility fixtures for `events.ndjson`, progress envelopes (socket-legacy and
  ndjson-envelope framings), `replay-timing.ndjson`, and the per-request diagnostics file.
- `cost.runnerRoundTrips` parity: the trait-derived set equals the current literal list; the
  existing `request-router-cost` test keeps passing unchanged.
- Redaction: a fixture proves a sensitive value emitted in `data` never reaches any sink output,
  including the replay timing trace (the currently unredacted path).
- Progress: `replay-test` and `command` progress render identically through the journal path
  (reporter/runtime tests unchanged); `--json` mode still emits no progress.
- Layering: `scripts/layering/check.ts` stays green — catalog in `contracts`, runtime in `utils`,
  no new back-edges.

## Migration plan

Each step lands green and independently useful:

1. **Catalog + typed kinds** — introduce `EVENT_CATALOG`, narrow `emitDiagnostic`'s `phase` to
   `EventKind`, migrate all emit sites mechanically (string values unchanged), derive
   `RUNNER_ROUND_TRIP_PHASES` from the `runner-round-trip` trait with a parity test. No runtime
   behavior change.
2. **Sink seam** — restructure `diagnostics.ts` so the scope owns an explicit sink list; move the
   debug stream and agent-cost tally behind it; delete `traceLogPath`; collapse to a single
   redaction pass. Byte-compat fixtures land here.
3. **Session event log as sink** — lifecycle emit points route through the journal; the
   `events.ndjson` writer becomes a sink; `events` command and pagination untouched.
4. **Replay trace as sink** — both trace helpers replaced by one sink; unredacted path closed.
5. **Progress as sink** — retire `src/request/progress.ts`'s separate storage; progress kinds and
   the wire serializer move behind the journal; transports unchanged.
