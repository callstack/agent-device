# ADR 0018: Unified Request Event Journal

## Status

Proposed (2026-07-24; revised same day after architecture review). Nothing here is implemented.

Scope reduction relative to the first draft, per review: progress streaming stays a permanent,
transport-owned second channel (it is an output port, not telemetry); the journal absorbs
diagnostics, agent-cost, the session event log, and the replay timing trace. Out-of-request
session events get an explicit scope model, and the replay-trace redaction fix is declared as an
intentional compatibility change rather than hidden under a byte-compatibility claim.

## Rules at a glance

Normative summary of the proposal; contracts and rationale below.

- One **event catalog** (`packages/contracts/src/events.ts`) is the single declaration site for every
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
  other sinks or the request). Concurrent sub-work (sharded test attempts run under
  `Promise.allSettled`) runs in **forked child scopes that clone every mutable binding** —
  envelope, log path, routing — and share only concurrency-safe aggregation state; nothing mutable
  is ever shared across concurrent scopes.
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
- Anything that leaves the machine goes through a **closed, allowlist-by-construction schema**
  (the usage sink's `UsageRecord`): every field drawn from a registry-enumerated vocabulary —
  command names, typed error codes, flag names, durations — with positionals, selectors, labels,
  and messages unrepresentable by type, not merely redacted.

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
   `session-test-runtime.ts`, read by `src/cli/replay-test/trace.ts`). Per-**attempt**
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

The near-term consumer motivating the unification is opt-in usage analytics over agent behavior —
command frequencies, failure codes, and outcome sequences that trip agents — under a hard privacy
constraint: request metadata only, never request content (decision 4).

ADR 0008 solved the same shape of problem for commands: one declaration registry, behavior derived
by parity-tested projection. This ADR applies that thesis to events — to the channels that are
genuinely telemetry. Progress is not one of them (decision 3).

## Decision

### 1. Event catalog: kinds are declared data

`packages/contracts/src/events.ts` exports one `EVENT_CATALOG` — a const object with one entry per event
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
- **Concurrency — fork, never rebind; forks clone all mutable state:** the journal gains a fork
  primitive: `journal.fork(bindings, fn)` runs `fn` inside a new AsyncLocalStorage scope object
  that **clones every mutable field of the parent scope** — the envelope (`session`, `command`,
  `debug`), `logPath`, and all routing bindings — applies the fork's own frozen `bindings` on top,
  and owns its own event buffer, flushed against the fork's bindings when the fork ends. Shared
  with the parent are only the sink list and concurrency-safe aggregation state: the `phaseCounts`
  tally stays request-global (single-threaded atomic increments; agent-cost must span shards).
  Sharded `test` runs execute attempts concurrently (`Promise.allSettled` in
  `runReplayTestShards`, `src/daemon/handlers/session-test.ts`) and their **nested dispatch calls
  `createRequestExecutionScope` (`request-router.ts` child scopes), which rebinds `session` and
  `logPath` mid-flight** — so a shared mutable envelope would cross-route debug and session-log
  events between shards even with frozen trace bindings. Therefore: `updateDiagnosticsScope`
  mutates only the innermost (current) scope, each shard/attempt lifecycle wraps its work —
  including all nested replay dispatch — in a fork, and every mid-flight rebind lands on that
  shard's clone. The fork's trace binding (the attempt's `replay-timing.ndjson` path) dies with
  the fork, so no clearing step exists to race; the replay trace sink drops trace-kind events
  emitted with no bound destination.
- **Scope identity (exporter readiness):** every scope — request, teardown, and fork — carries a
  `scopeId`, and a fork records its parent's as `parentScopeId`; both ride the event envelope.
  This is deliberately minimal span plumbing: forks already form a tree, so a future exporter sink
  (e.g. OpenTelemetry) can emit real parent-child spans from envelope fields alone, without
  retrofitting the envelope or touching emit sites. Cross-process correlation stays `requestId`
  (already stamped on both sides of the RPC); a W3C `traceparent`-style request-meta field is
  additive under ADR 0006 and deferred to whatever ADR introduces an exporter. No exporter is part
  of this ADR.

**Registered sinks:**

- **debug stream sink** — today's debug-mode live ndjson writer (per-request file / `daemon.log` /
  stderr fallback), unchanged behavior including the `liveWrittenEventCount` flush watermark;
- **session event log sink** — consumes the `session-lifecycle` trait kinds and writes today's
  `events.ndjson` v1 entries, reusing the existing presentation builders (`buildActionSummary`,
  `buildRequestSuccessEventPresentation`), write queue, and retention window
  (`session-event-log-window.ts`, #1788: size-capped rotation to one retained generation,
  `events.ndjson.1`). Entry bytes are unchanged by the cap, but the window's sidecar
  (`events.ndjson.window.json`) is **new journal-owned state that cursor identity depends on**:
  it records each retained generation's first absolute line index, line count, and first-line
  digest, and the reader verifies those against the files before answering. A sink that ever owns
  this file owns that contract too — it is not a cache and cannot be regenerated from the entries;
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

### 4. First planned consumer: the usage sink (privacy by construction)

The motivating consumer for this architecture is opt-in **usage analytics over agent behavior**:
which commands run, how often, what fails with which error codes, and outcome sequences that trip
agents (consecutive full snapshots, screenshot-after-snapshot, repeated same-command failures).
The unit of observation is request **metadata**, never request **content**.

The privacy rule is therefore **allowlist by construction, not redaction**. Redaction is a
blocklist over rich data and one missed field leaks a selector or label; the usage sink instead
projects `session-lifecycle` events into a closed `UsageRecord` schema in which every field draws
from an enumerated vocabulary:

- `command`/action — enumerated by the CommandDescriptor registry;
- outcome — `ok` or the typed error **code** (ADR 0010's closed set); never the error message;
- `durationMs`, cost fields (`runnerRoundTrips`, `nodeCount`), `platform`/`appleOs`;
- flag **names** present on the request — never flag values;
- a hashed session identity plus per-session sequence number, so command bigrams are computable
  downstream.

Positionals, selectors, labels, fill text, snapshot content, and error messages are unrepresentable
in the schema — there is nothing to scrub. Sequence/anti-pattern detection is downstream analysis
over the record stream (a local stats read first; opt-in export later), never emission-side logic.
The sink itself is a follow-up landing after migration step 3 (it consumes the
`session-lifecycle` kinds); this ADR fixes only its schema discipline so no richer interim export
gets built.

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
- Retention: the size cap (#1788) is orthogonal to sink ownership but shares the file. A sink
  migration keeps rotation inside the one serialized write path, keeps the sidecar written before
  the rename it describes, and keeps reads failing typed
  (`EVENT_LOG_CURSOR_EXPIRED` / `EVENT_LOG_WINDOW_UNVERIFIED`) rather than answering a cursor it
  cannot place.
- Per-attempt routing: a multi-attempt `test` run writes each attempt's trace to its own file with
  legacy `type` values; trace-kind events emitted with no bound destination are dropped, not
  misrouted. A **concurrent nested-action regression** runs sharded attempts in parallel — each
  performing nested dispatch that rebinds `session`/`logPath` via `createRequestExecutionScope` —
  and proves per-fork isolation across **all three routed outputs**: each `replay-timing.ndjson`,
  each per-request diagnostics ndjson, and each session's `events.ndjson` plus its retained generation contain only
  their own shard's events — no cross-writes, no drops — including events emitted after `await` points.
- Sink isolation: a sink that throws does not affect the buffer, other sinks, or the response;
  ordering across sinks is registration order.
- `cost.runnerRoundTrips` parity: the trait-derived set equals the current literal list; the
  existing `request-router-cost` test keeps passing unchanged.
- Redaction: a fixture proves a sensitive value emitted in `data` never reaches any journal-owned
  sink output, including the replay timing trace.
- Usage schema gate: a type/test check proves every `UsageRecord` field's vocabulary source — a
  field is either numeric, an enum imported from the owning registry (command names, error codes,
  flag keys), or a hash — and that no open-string field exists; adding one is a failing gate, not
  a review comment.
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
   `events` command keeps its paging contract, including the typed cursor-expiry and
   window-verification errors the #1788 retention window added to it.
4. **Replay trace as sink** — the journal fork primitive lands with its concurrent-shard
   regression; both trace helpers are replaced by one sink with fork-bound per-attempt routing and
   legacy `type` mapping; the declared redaction change ships here with its fixture and changelog
   entry.
