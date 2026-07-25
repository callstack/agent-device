# ADR 0017: Unified Request Event Journal

## Status

Proposed (2026-07-24; revised same day after architecture review). Nothing here is implemented.

Scope reduction relative to the first draft, per review: progress streaming stays a permanent,
transport-owned second channel (it is an output port, not telemetry); the journal absorbs
diagnostics, agent-cost, the session event log, and the replay timing trace. Out-of-request
session events get an explicit scope model, and the replay-trace redaction fix is declared as an
intentional compatibility change rather than hidden under a byte-compatibility claim.

## Rules at a glance

Normative summary of the proposal; contracts and rationale below.

- One **event catalog** (`src/contracts/events.ts`) is the single declaration site for every
  diagnostic/telemetry event kind: key, subsystem, default level, and derivation traits. Emitting a
  kind not in the catalog is a compile error; consumers derive kind sets from traits, never from
  parsing kind names.
- Catalog keys are **internal identities**. Legacy wire/file discriminators (today's diagnostics
  `phase` strings, the replay trace's `type` values) are preserved by sinks as output mappings;
  a wire name is never automatically the canonical cross-channel identity.
- One **journal** per scope is the single append point (`emitDiagnostic` evolves into it). Scopes
  are: the existing per-request scope, and explicit short-lived **session-scoped teardown scopes**
  for out-of-request work (idle reap, daemon shutdown), following the existing fatal-scope
  precedent. Emitters state facts; they never know who is listening. No `EventEmitter`, no dynamic
  subscription.
- Every consumer is a **sink**: explicitly registered at scope construction, invoked synchronously
  in registration order, individually best-effort (a sink error is swallowed and must not affect
  other sinks or the request). Sinks with dynamic destinations (the per-attempt replay trace) read
  **immutable routing bindings carried by a forked child scope** — concurrent sub-work (sharded
  test attempts run under `Promise.allSettled`) forks, never rebinds shared scope state.
- **Progress streaming is not journal-owned.** `src/request/progress.ts` and its typed
  `RequestProgressEvent` union remain the transport's channel, unchanged.
- **Existing formats do not change, with one declared exception.** `events.ndjson` v1 entries,
  `cost.runnerRoundTrips`, per-request diagnostics ndjson, and `replay-timing.ndjson` shapes stay
  byte-compatible behind golden fixtures. The exception: replay-timing events written by the
  currently unredacted helper become redacted — an intentional security fix, called out as a
  behavior change, not smuggled in as "compatible."
- **Redaction happens once, at the journal boundary**, for every journal-owned output.
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
   three request-lifecycle points plus `SessionStore.recordAction`, read only by the public
   `events` command. `action.recorded` is already a projection of `session.actions` pushes — the
   model this ADR generalizes. Crucially, not every append happens inside a request:
   `finalizeRepairTeardown` (`src/daemon/session-store.ts`) records a synthesized `close` action
   during idle reap or daemon shutdown, with — per its own comment — "no live request here."
3. **Progress streaming** (`src/request/progress.ts`, `src/daemon/request-progress-protocol.ts`).
   A closed, typed `RequestProgressEvent` union emitted through a single-sink `AsyncLocalStorage`
   installed by the socket/HTTP transport, serialized as ndjson envelopes multiplexed onto the same
   stream as the final response, with client-disconnect-as-cancellation tracking. Opt-in per
   request via `meta.requestProgress`; disabled under `--json`. Events are written to the wire
   **unredacted** today.
4. **Replay timing trace** (`src/daemon/handlers/session-replay-trace.ts`,
   `session-test-runtime.ts`, read by `src/replay/test/trace.ts`). Per-**attempt**
   `replay-timing.ndjson` files whose paths are created dynamically inside each attempt — written
   by **two different helpers, one of which redacts and one of which does not**
   (`appendReplayTraceEvent` vs `appendReplayTestTimingEvent`).

(`src/upload-progress.ts` is a fifth, local-only callback sink for artifact uploads; it never
crosses the request scope and is out of scope here. Production code contains no `EventEmitter`
usage at all — the codebase already avoids implicit pub/sub, which this design preserves.)

The channels overlap but share nothing: no common envelope, no shared kind vocabulary, and
consumers couple to emit sites by string. The sharpest instance: agent-cost's `runnerRoundTrips`
is `countDiagnosticEventsByPhase(['ios_runner_command_send', 'ios_runner_readiness_preflight'])`
(`src/daemon/request-router.ts`) — a hand-picked name list a new runner phase can silently drift
from. That violates two established repo rules: *what enumerates N?* (nothing enumerates
round-trip phases), and *categories come from recorded fields, never parsed names*.

ADR 0008 solved the same shape of problem for commands: one declaration registry, behavior derived
by parity-tested projection. This ADR applies that thesis to events — to the channels that are
genuinely telemetry. Progress is not one of them (decision 3).

## Decision

### 1. Event catalog: kinds are declared data

`src/contracts/events.ts` exports one `EVENT_CATALOG` — a const object with one entry per event
kind, keyed by today's diagnostics phase strings (no renames in this ADR):

```ts
type EventDescriptor = {
  /** Grouping for docs/filtering; not parsed from the kind name. */
  subsystem: 'apple-runner' | 'android' | 'daemon' | 'request' | 'record' | 'replay'
    | 'snapshot' | 'cli' | 'web' | 'compat' | 'util';
  level: 'info' | 'warn' | 'error' | 'debug';
  /** Derivation traits — the only way a consumer may select kind sets. */
  traits?: readonly EventTrait[]; // e.g. 'runner-round-trip', 'session-lifecycle', 'replay-trace'
};

type EventKind = keyof typeof EVENT_CATALOG;
```

`emitDiagnostic`'s `phase` parameter narrows from `string` to `EventKind`, making every
uncataloged emit a compile error — the same completeness mechanism as the ADR 0011 matrix. The
existing ~155 phases enter the catalog verbatim; per-kind `data` payloads stay
`Record<string, unknown>` in this ADR (typed payload schemas are a possible per-kind follow-up,
not a prerequisite — see Alternatives).

Kinds absorbed from other channels (the session event log's `request.started`/`request.finished`/
`action.recorded`, the replay trace's `replay_action_start`/`replay_action_stop`/attempt-lifecycle
events) get catalog entries whose **internal keys need not equal their legacy wire discriminators**;
the owning sink maps the internal kind to the exact legacy `kind`/`type` value on output. Wire and
file names stay frozen for consumers; catalog identities stay free to be consistent.

Consumers derive kind sets from traits: `RUNNER_ROUND_TRIP_PHASES` becomes
`kindsWithTrait('runner-round-trip')` (exactly `ios_runner_command_send` and
`ios_runner_readiness_preflight` carry the trait; their `_skipped`/`_recovered` variants
deliberately do not, preserving today's cost semantics). A parity test pins the derived sets so a
trait edit is a reviewed decision, not a drift.

The catalog lives in `contracts` (ranked, kernel-adjacent) so every zone — including unranked
peripherals and `utils` — may import it without a layering back-edge. The journal runtime evolves
in place in `src/utils/diagnostics.ts`, keeping all existing import directions legal.

### 2. One journal, explicit sinks, defined scope model

The diagnostics scope becomes the **journal**: the single append point for diagnostics, agent-cost
tallies, session lifecycle events, and replay traces. `emit(event)` does exactly what
`emitDiagnostic` does today — stamp the scope envelope (`ts`, `requestId?`, `session?`,
`command?`), redact `data`, buffer, tally `phaseCounts` — and then offers the event to each
registered sink.

**Scope model.** Two scope shapes, both explicit:

- the existing **per-request scope** (CLI entry, daemon `handleRequest`, fatal catch-all),
  unchanged; and
- a **session-scoped teardown scope** for out-of-request work: idle reap and daemon-shutdown
  finalizers (`finalizeRepairTeardown`, session teardown cleanup) open a short-lived scope bound to
  the session (no `requestId`), following the existing `emitFatalDiagnostic` precedent. This is
  what keeps "no sink writes without the journal" true for the teardown-recorded `close` action —
  today's direct event-log append from `SessionStore.recordAction` must keep working when no
  request exists, and silently dropping it is unacceptable.

**Sink contract.** Sinks are constructed with the scope and listed in one place per entry point —
statically enumerable, greppable, no dynamic subscription API. Semantics, normative:

- **Ordering:** sinks are invoked synchronously, in registration order, at emit time. A sink may
  queue its own I/O (the session event log keeps its per-path serialized write queue).
- **Isolation:** each sink invocation is individually best-effort — an error is swallowed (as
  `emitDiagnostic`'s stream writes are today) and must never affect other sinks, the buffer, or
  the request.
- **Flushing:** flush remains journal-owned (`flushDiagnosticsToSessionFile` semantics unchanged);
  sinks that buffer expose flush hooks the journal calls on request finalization and fatal paths.
- **Dynamic destinations — fork, never rebind:** a sink whose output path is not known at scope
  construction reads **immutable routing bindings** carried by the current scope. The journal
  gains a fork primitive: `journal.fork(bindings, fn)` runs `fn` inside a new AsyncLocalStorage
  scope object that shares the parent's buffer, `phaseCounts`, envelope, and sink list, but
  carries its own **frozen** bindings. Sharded `test` runs execute attempts concurrently
  (`Promise.allSettled` in `runReplayTestShards`, `src/daemon/handlers/session-test.ts`) under one
  inherited request scope, so mutating shared scope state to route traces would let one attempt
  overwrite or clear another's destination after an `await`. Instead, each attempt's lifecycle
  wraps its work — including all nested replay dispatch — in a fork binding that attempt's
  `replay-timing.ndjson` path; the binding dies with the fork, so no clearing step exists to race.
  The sink drops trace-kind events emitted with no bound destination. The existing
  `updateDiagnosticsScope` rebinds (`session`, `logPath` in `createRequestExecutionScope`) remain:
  they run once during sequential request setup, before any concurrency fan-out; new routing
  context for parallel or attempt-scoped work must use forks.

**Registered sinks:**

- **debug stream sink** — today's debug-mode live ndjson writer (per-request file / `daemon.log` /
  stderr fallback), unchanged behavior including the `liveWrittenEventCount` flush watermark;
- **session event log sink** — consumes the `session-lifecycle` trait kinds and writes today's
  `events.ndjson` v1 entries, reusing the existing presentation builders (`buildActionSummary`,
  `buildRequestSuccessEventPresentation`) and write queue; receives events from request scopes and
  teardown scopes alike;
- **replay trace sink** — consumes `replay-trace` trait kinds, maps internal kinds to the legacy
  `type` values, writes the per-attempt file via bound routing context; replaces both existing
  append helpers;
- **agent-cost tally** — already a projection (`phaseCounts`); now reads its kind set from the
  `runner-round-trip` trait.

The request-lifecycle points that today call `sessionStore.recordEvent`/`appendActionEvent`
directly (`request-execution-scope.ts`, `request-router.ts`, `session-store.ts`) instead `emit`
the corresponding journal kinds; the sink owns the file. `SessionAction` recording itself is
untouched: `recordActionEntry` still pushes to `session.actions` first, and the `action.recorded`
journal event remains a projection of that push.

### 3. Progress streaming stays a separate, transport-owned channel

Progress is an **output port of the transport**, not telemetry: it has ordering and
interleaving guarantees relative to the final response on the same stream, client-disconnect
tracking that feeds request cancellation, a closed typed union (`RequestProgressEvent`) consumed
directly by the wire serializer, and a single-sink `AsyncLocalStorage` installed by the transport
outside `handleRequest`. Forcing it through the journal would either weaken its payload type to
`Record<string, unknown>` at the wire boundary or make the journal envelope part of the RPC
protocol — both worse than the status quo. It also writes unredacted today, so journal-boundary
redaction would silently alter wire bytes.

`src/request/progress.ts`, `request-progress-protocol.ts`, and both transports are therefore
unchanged by this ADR. If a future feature needs progress events in the journal (e.g. a request
timeline), the correct shape is a **mirror emit** — the progress emitter additionally emitting a
cataloged journal kind — never rerouting the wire path through the journal. That is a separate,
opt-in decision.

## Invariants

- **Byte compatibility, one declared exception.** `events.ndjson` v1, per-request diagnostics
  ndjson, `replay-timing.ndjson` shapes and legacy `type` discriminators, and
  `cost.runnerRoundTrips` are produced identically by the sinks; golden fixtures under
  `contracts/fixtures/` pin each format. The declared exception: replay-timing events from the
  previously unredacted helper become redacted (URL query stripping, sensitive-key masking, long
  string truncation may alter those lines). This is an intentional security fix shipped as such —
  changelog-visible, fixture-updated — not an unnoticed side effect.
- **Single redaction boundary for journal-owned outputs.** `redactDiagnosticData` runs once, on
  append. The flush path's second whole-entry pass is retained only until sinks own their writes,
  then removed. No sink may write an event that did not pass through the journal. (Progress is not
  journal-owned and keeps its current unredacted wire behavior.)
- **Emitters never branch on consumers.** An emit site must not know or care whether debug mode or
  a replay trace is active. Anything consumer-conditional lives in the sink.
- **No state from events.** The journal is write-only telemetry. Recovering session state, replay
  provenance, or repair watermarks from journal events is out of scope and rejected (see
  Alternatives).
- **Traits over names.** No production code may select events by matching kind-name substrings
  (`startsWith('ios_runner_')` etc.); a lint-style test enforces this for the derived-set helpers.

## Consequences

- Traceability becomes "filter the journal by `requestId`" (or by `session` for teardown scopes):
  one envelope, one ordering, across what are today three telemetry files with different envelope
  shapes. Progress remains separately observable on the wire, as an operational channel should be.
- New observability features (a timeline command, an OTel exporter, a perf-phase report) are new
  sinks — no new emit sites, no new vocabularies.
- Adding an event kind is a catalog entry plus emit sites; forgetting the catalog is a compile
  error. Renaming an internal kind is invisible on the wire when the owning sink maps it; changing
  a **wire** name remains a breaking change for log consumers and needs the same care as today.
- The dead `traceLogPath` option, the duplicate redaction pass, and the unredacted replay-timing
  helper are deleted; replay-timing redaction is the one visible output change.
- Cost: a mechanical, wide migration (~70 files import the typed kind; the string values
  themselves do not change, so diffs are type-level). Runtime overhead is one synchronous
  sink-dispatch loop per event over today's buffer push — negligible against device I/O.

## Alternatives considered

- **Absorb progress streaming into the journal** (the first draft's step 5): rejected after
  review. Progress is a transport-owned output port with ordering, cancellation, and closed-union
  type-safety requirements; rerouting it through a generic journal weakens a protocol contract to
  gain nothing operationally. Mirror emits remain available if journal visibility is ever needed.
- **One closed discriminated union with typed payloads per kind:** rejected for this ADR — 155
  kinds × payload schemas is a large, low-yield migration, and payload types can be added per-kind
  incrementally once the catalog exists. The catalog is the enforcement point; payload typing is a
  follow-up, not a prerequisite. (Progress keeps its typed union precisely because it stays on its
  own channel.)
- **`EventEmitter`/pub-sub bus:** rejected. Implicit subscription defeats both goals: deletability
  (who listens is not statically visible) and traceability (causality disappears into `.on()`).
  The codebase currently has zero production `EventEmitter` usage; this design keeps it that way.
- **Event sourcing (rebuild session state from the journal):** rejected. Session state has owners
  (`SessionStore`, ref frames, repair transactions) with their own invariants and gates; deriving
  it from telemetry would couple correctness to an observability channel and is a large behavioral
  rewrite with no user-facing benefit.
- **A process-global fallback scope instead of explicit teardown scopes:** rejected — an ambient
  catch-all scope would make "which scope did this event land in" environment-dependent and hide
  missing-scope bugs; teardown entry points are few and known, so explicit scopes are cheap.
- **Leave the channels, just type the phases:** considered as a stopping point — step 1 alone
  fixes the stringly agent-cost coupling — but it leaves the duplicate envelopes, the redaction
  inconsistency, and three write paths. Kept as the migration's first independently useful step
  instead.
- **Merge `upload-progress` and `app-events` in:** rejected. Upload progress is a local
  byte-counter callback that never crosses the request scope; `core/app-events.ts` is a deep-link
  builder for the `trigger-app-event` command, not an event channel.

## Validation required for implementation

- Type-level completeness: an emit with an uncataloged kind fails to compile. Orphan detection
  (declared-but-never-emitted kinds) is **static**: a source-scan check in the layering-lint style
  proves every catalog kind has at least one emit reference; runtime observation is explicitly not
  the mechanism (it conflates untested branches with dead declarations).
- Golden byte-compatibility fixtures for `events.ndjson`, the per-request diagnostics file, and
  `replay-timing.ndjson` — the latter's fixture updated once, in the same change that declares the
  redaction fix.
- Out-of-request coverage: an idle-reap/shutdown `finalizeRepairTeardown` still lands its
  synthesized `close` as an `action.recorded` entry in `events.ndjson`, via a teardown scope, with
  no request active.
- Per-attempt routing: a multi-attempt `test` run writes each attempt's trace to its own file with
  legacy `type` values; trace-kind events emitted with no bound destination are dropped, not
  misrouted. A **concurrent-shard regression** runs sharded attempts in parallel and proves each
  `replay-timing.ndjson` contains only its own attempt's events — no cross-writes, no drops —
  including events emitted from nested replay work after `await` points.
- Sink isolation: a sink that throws does not affect the buffer, other sinks, or the response;
  ordering across sinks is registration order.
- `cost.runnerRoundTrips` parity: the trait-derived set equals the current literal list; the
  existing `request-router-cost` test keeps passing unchanged.
- Redaction: a fixture proves a sensitive value emitted in `data` never reaches any journal-owned
  sink output, including the replay timing trace.
- Layering: `scripts/layering/check.ts` stays green — catalog in `contracts`, runtime in `utils`,
  no new back-edges.

## Migration plan

Each step lands green and independently useful:

1. **Catalog + typed kinds** — introduce `EVENT_CATALOG`, narrow `emitDiagnostic`'s `phase` to
   `EventKind`, migrate all emit sites mechanically (string values unchanged), derive
   `RUNNER_ROUND_TRIP_PHASES` from the `runner-round-trip` trait with a parity test, add the
   static orphan check. No runtime behavior change.
2. **Sink seam** — restructure `diagnostics.ts` so the scope owns an explicit sink list with the
   ordering/isolation/flush contract; move the debug stream and agent-cost tally behind it; delete
   `traceLogPath`; collapse to a single redaction pass. Byte-compat fixtures land here.
3. **Session event log as sink + teardown scopes** — request-lifecycle emit points route through
   the journal; the `events.ndjson` writer becomes a sink; idle-reap/shutdown finalizers open
   session-scoped teardown scopes so out-of-request `action.recorded` events keep flowing; the
   `events` command and pagination untouched.
4. **Replay trace as sink** — the journal fork primitive lands with its concurrent-shard
   regression; both trace helpers are replaced by one sink with fork-bound per-attempt routing and
   legacy `type` mapping; the declared redaction change ships here with its fixture and changelog
   entry.
