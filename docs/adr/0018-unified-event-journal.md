# ADR 0018: Unified Request Event Journal

## Status

Proposed (2026-07-24; revised the same day after architecture review).
Nothing here is implemented.

The review reduced the scope relative to the first draft:

- Progress streaming stays a permanent, transport-owned second channel.
  It is an output port, not telemetry.
- The journal would absorb diagnostics, agent-cost, the session event log, and the replay timing trace.
- Out-of-request session events would get an explicit scope model.
- The ADR declares the replay-trace redaction fix as an intentional compatibility change.
  It does not hide the fix under a byte-compatibility claim.

## Rules at a glance

This section is the normative summary of the proposal.
The contracts and the rationale follow below.

- One **event catalog** (`packages/contracts/src/events.ts`) is the single declaration site for every diagnostic/telemetry event kind.
  For each kind, it declares the key, the subsystem, the default level, and the derivation traits.
  An emit of a kind that is not in the catalog is a compile error.
  Consumers derive kind sets from traits, never from parsing kind names.
- Catalog keys are **internal identities**.
  Sinks preserve the legacy wire/file discriminators as output mappings.
  These discriminators are today's diagnostics `phase` strings and the replay trace's `type` values.
  A wire name is never automatically the canonical cross-channel identity.
- One **journal** per scope is the single append point.
  `emitDiagnostic` evolves into it.
  There are two kinds of scope:
  - the existing per-request scope;
  - explicit short-lived **session-scoped teardown scopes** for out-of-request work (idle reap, daemon shutdown).
    These follow the existing fatal-scope precedent.

  Emitters state facts.
  They never know who is listening.
  There is no `EventEmitter` and no dynamic subscription.

- Every consumer is a **sink**.
  Each sink is explicitly registered at scope construction.
  Sinks are invoked synchronously in registration order.
  Each sink is individually best-effort: the journal swallows a sink error, and that error must not affect other sinks or the request.
  Concurrent sub-work (sharded test attempts that run under `Promise.allSettled`) runs in **forked child scopes that clone every mutable binding**: envelope, log path, and routing.
  Forked scopes share only concurrency-safe aggregation state.
  Nothing mutable is ever shared across concurrent scopes.
- **Progress streaming is not journal-owned.**
  `packages/host-kit/src/internal/request-progress.ts` and its typed `RequestProgressEvent` union (`packages/contracts/src/request-progress.ts`) remain the transport's channel, unchanged.
- **Existing formats do not change, with one declared exception.**
  `events.ndjson` v1 entries, `cost.runnerRoundTrips`, per-request diagnostics ndjson, and `replay-timing.ndjson` shapes stay byte-compatible behind golden fixtures.
  The exception: replay-timing events that the currently unredacted helper writes become redacted.
  This is an intentional security fix.
  The ADR calls it out as a behavior change and does not smuggle it in as "compatible."
- **Redaction happens once, at the journal boundary**, for every journal-owned output.
- The journal is for observability.
  It is **not** a source of truth.
  `session.actions` and all other session state remain owned by their stores.
  No state is ever rebuilt from journal events.
- Anything that leaves the machine goes through a **closed, allowlist-by-construction schema**: the usage sink's `UsageRecord`.
  Every field comes from a registry-enumerated vocabulary: command names, typed error codes, flag names, and durations.
  Positionals, selectors, labels, and messages are unrepresentable by type, not merely redacted.

## Context

The codebase has grown four parallel event vocabularies (inventory of 2026-07-24).
Each has its own emit call, shape, redaction discipline, and sink:

1. **Diagnostics** (`packages/host-kit/src/internal/diagnostics.ts`).
   It has about 155 distinct stringly-typed `phase` values across about 70 files.
   Code enters its `AsyncLocalStorage` request scope in exactly three places:
   CLI pre-parse, daemon per-request in `request-router.ts`, and the daemon fatal catch-all.
   It has an in-memory buffer and a `phaseCounts` tally.
   In debug mode, it streams live to one of these destinations:
   the per-request ndjson file (after `createRequestExecutionScope` rebinds `logPath`), `daemon.log`, or stderr.
   The `traceLogPath` scope option is dead: no call site ever sets it.
2. **Session event log** (`@agent-device/session-journal/session-event-log`).
   It is an append-only per-session `events.ndjson` file with the kinds `request.started`, `request.finished`, and `action.recorded`.
   Three request-lifecycle points and `SessionStore.recordAction` write it.
   Only the public `events` command reads it.
   `action.recorded` is already a projection of `session.actions` pushes.
   This ADR generalizes that model.
   Not every append happens inside a request.
   `finalizeRepairTeardown` (`packages/daemon/src/core/session-store.ts`) records a synthesized `close` action during idle reap or daemon shutdown.
   Its own comment says: "no live request here."
3. **Progress streaming** (`packages/host-kit/src/internal/request-progress.ts`, `packages/daemon-contracts/src/request-progress-protocol.ts`).
   It is a closed, typed `RequestProgressEvent` union.
   Code emits it through a single-sink `AsyncLocalStorage` that the socket/HTTP transport installs.
   The transport serializes the events as ndjson envelopes on the same stream as the final response.
   The channel tracks a client disconnect as a cancellation.
   It is opt-in for each request through `meta.requestProgress`.
   It is disabled under `--json`.
   Today, the events go to the wire **unredacted**.
4. **Replay timing trace** (`packages/replay-port/src/daemon-port/session-replay-trace.ts` and `packages/replay-test/src/internal/session-test-runtime.ts`, read by `src/cli/replay-test/trace.ts`).
   It writes per-**attempt** `replay-timing.ndjson` files.
   Each attempt creates its file path dynamically.
   **Two different helpers write these files, and one of them redacts and one does not** (`appendReplayTraceEvent` vs `appendReplayTestTimingEvent`).

`packages/remote/src/upload-progress.ts` is a fifth, local-only callback sink for artifact uploads.
It never crosses the request scope, and it is out of scope here.
Production code contains no `EventEmitter` usage at all.
The codebase already avoids implicit pub/sub, and this design preserves that.

The channels overlap but share nothing.
They have no common envelope and no shared kind vocabulary.
Consumers couple to emit sites by string.
The sharpest instance is agent-cost's `runnerRoundTrips`.
It is `countDiagnosticEventsByPhase(['ios_runner_command_send', 'ios_runner_readiness_preflight'])` (`packages/daemon/src/server/request-router.ts`).
This is a hand-picked name list, and a new runner phase can silently drift from it.
That violates two established repository rules:

- *what enumerates N?* Nothing enumerates round-trip phases.
- *categories come from recorded fields, never parsed names*.

The near-term consumer that motivates the unification is opt-in usage analytics over agent behavior.
It covers command frequencies, failure codes, and outcome sequences that cause agents to fail.
It has a hard privacy constraint: request metadata only, never request content (decision 4).

ADR 0008 solved the same shape of problem for commands: one declaration registry, and behavior derived by parity-tested projection.
This ADR applies that thesis to events, but only to the channels that are genuinely telemetry.
Progress is not one of them (decision 3).

## Decision

### 1. Event catalog: kinds are declared data

This section proposes that `packages/contracts/src/events.ts` exports one `EVENT_CATALOG`.
It is a const object with one entry for each event kind.
Today's diagnostics phase strings are its keys.
This ADR renames no phase:

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

`emitDiagnostic`'s `phase` parameter narrows from `string` to `EventKind`.
Then every uncataloged emit is a compile error.
This is the same completeness mechanism as the ADR 0011 matrix.
The existing ~155 phases enter the catalog verbatim.
In this ADR, per-kind `data` payloads stay `Record<string, unknown>`.
Typed payload schemas are a possible per-kind follow-up, not a prerequisite (see Alternatives).

The kinds absorbed from other channels are these:

- from the session event log: `request.started`, `request.finished`, and `action.recorded`;
- from the replay trace: `replay_action_start`, `replay_action_stop`, and the attempt-lifecycle events.

These kinds get catalog entries.
Their **internal keys need not equal their legacy wire discriminators**.
On output, the owning sink maps the internal kind to the exact legacy `kind`/`type` value.
Wire and file names stay frozen for consumers.
Catalog identities stay free to be consistent.

Consumers derive kind sets from traits.
`RUNNER_ROUND_TRIP_PHASES` becomes `kindsWithTrait('runner-round-trip')`.
Exactly `ios_runner_command_send` and `ios_runner_readiness_preflight` carry the trait.
Their `_skipped`/`_recovered` variants deliberately do not, so today's cost semantics stay the same.
A parity test pins the derived sets, so a trait edit is a reviewed decision, not a drift.

The catalog lives in `contracts` (ranked, kernel-adjacent), so every zone may import it without a layering back-edge.
The journal runtime evolves in place in `packages/host-kit/src/internal/diagnostics.ts`.
Thus all existing import directions stay legal.

### 2. One journal, explicit sinks, defined scope model

This section proposes that the diagnostics scope becomes the **journal**.
The journal is the single append point for diagnostics, agent-cost tallies, session lifecycle events, and replay traces.
`emit(event)` does exactly what `emitDiagnostic` does today:

1. Stamp the scope envelope (`ts`, `requestId?`, `session?`, `command?`).
2. Redact `data`.
3. Buffer the event.
4. Tally `phaseCounts`.

After these steps, `emit(event)` would offer the event to each registered sink.

**Scope model.** There are two scope shapes.
Both are explicit:

- The existing **per-request scope** (CLI entry, daemon `handleRequest`, fatal catch-all) is unchanged.
- A **session-scoped teardown scope** is for out-of-request work.
  Idle reap and daemon-shutdown finalizers (`finalizeRepairTeardown`, session teardown cleanup) would open a short-lived scope bound to the session, with no `requestId`.
  This follows the existing `emitFatalDiagnostic` precedent.
  This scope keeps the rule "no sink writes without the journal" true for the teardown-recorded `close` action.
  Today's direct event-log append from `SessionStore.recordAction` must keep working when no request exists.
  To silently drop it is unacceptable.

**Sink contract.** Sinks are constructed with the scope.
Each entry point lists its sinks in one place.
The list is statically enumerable and greppable.
There is no dynamic subscription API.
These semantics are normative:

- **Ordering:** the journal invokes sinks synchronously, in registration order, at emit time.
  A sink may queue its own I/O.
  For example, the session event log keeps its per-path serialized write queue.
- **Isolation:** each sink invocation is individually best-effort.
  The journal swallows a sink error, as `emitDiagnostic` does for its stream writes today.
  The error must never affect other sinks, the buffer, or the request.
- **Flushing:** flush remains journal-owned.
  `flushDiagnosticsToSessionFile` semantics do not change.
  Sinks that buffer expose flush hooks.
  The journal calls these hooks on request finalization and on fatal paths.
- **Concurrency — fork, never rebind; forks clone all mutable state:** the journal gains a fork primitive, `journal.fork(bindings, fn)`.
  It runs `fn` inside a new AsyncLocalStorage scope object.
  That scope object **clones every mutable field of the parent scope**: the envelope (`session`, `command`, `debug`), `logPath`, and all routing bindings.
  It applies the fork's own frozen `bindings` on top.
  It owns its own event buffer, and it flushes that buffer against the fork's bindings when the fork ends.
  The fork shares only the sink list and concurrency-safe aggregation state with the parent.
  The `phaseCounts` tally stays request-global (single-threaded atomic increments), because agent-cost must span shards.

  Sharded `test` runs execute attempts concurrently (`Promise.allSettled` in `runReplayTestShards`, `packages/replay-test/src/internal/session-test.ts`).
  Their **nested dispatch calls `createRequestExecutionScope` (`request-router.ts` child scopes), which rebinds `session` and `logPath` mid-flight**.
  Thus a shared mutable envelope would cross-route debug and session-log events between shards, even with frozen trace bindings.
  Therefore, this proposal has three rules:
  - `updateDiagnosticsScope` mutates only the innermost (current) scope.
  - Each shard/attempt lifecycle wraps its work, including all nested replay dispatch, in a fork.
  - Every mid-flight rebind goes to that shard's clone.

  The fork's trace binding (the attempt's `replay-timing.ndjson` path) ends with the fork.
  Thus no clearing step exists that can race.
  The replay trace sink drops trace-kind events emitted with no bound destination.

- **Scope identity (exporter readiness):** every scope (request, teardown, and fork) carries a `scopeId`.
  A fork records the `scopeId` of its parent as `parentScopeId`.
  Both fields are in the event envelope.
  This is deliberately minimal span plumbing.
  The proposed forks form a tree.
  Thus a future exporter sink (for example, OpenTelemetry) can emit real parent-child spans from envelope fields alone.
  It does not need to retrofit the envelope or change emit sites.
  Cross-process correlation stays `requestId`, which is already stamped on both sides of the RPC.
  A W3C `traceparent`-style request-meta field is additive under ADR 0006.
  It is deferred to the ADR that introduces an exporter.
  No exporter is part of this ADR.

**Registered sinks:**

- **debug stream sink**: today's debug-mode live ndjson writer (per-request file / `daemon.log` / stderr fallback).
  Its behavior does not change, including the `liveWrittenEventCount` flush watermark.
- **session event log sink**: consumes the `session-lifecycle` trait kinds and writes today's `events.ndjson` v1 entries.
  It reuses the existing presentation builders (`buildActionSummary`, `buildRequestSuccessEventPresentation`), the write queue, and the retention window.
  The retention window (`session-event-log-window.ts`, #1788) is size-capped rotation to one retained generation, `events.ndjson.1`.
  The cap does not change entry bytes.
  But the window's sidecar (`events.ndjson.window.json`) is **new journal-owned state that cursor identity depends on**.
  The sidecar records the first absolute line index, the line count, and the first-line digest of each retained generation.
  Before the reader answers, it verifies those values against the files.
  A sink that ever owns this file owns that contract too.
  The sidecar is not a cache, and it cannot be regenerated from the entries.
- **replay trace sink**: consumes `replay-trace` trait kinds and maps internal kinds to the legacy `type` values.
  It writes the per-attempt file through the bound routing context.
  It replaces both existing append helpers.
- **agent-cost tally**: already a projection (`phaseCounts`).
  It would read its kind set from the `runner-round-trip` trait.

Today, some request-lifecycle points call `sessionStore.recordEvent`/`appendActionEvent` directly (`request-execution-scope.ts`, `request-router.ts`, `session-store.ts`).
These points would instead `emit` the corresponding journal kinds.
The sink owns the file.
`SessionAction` recording itself is untouched.
`recordActionEntry` still pushes to `session.actions` first.
The `action.recorded` journal event remains a projection of that push.

### 3. Progress streaming stays a separate, transport-owned channel

Progress is an **output port of the transport**, not telemetry.
It has these properties:

- ordering and interleaving guarantees relative to the final response on the same stream;
- client-disconnect tracking that feeds request cancellation;
- a closed typed union (`RequestProgressEvent`) that the wire serializer consumes directly;
- a single-sink `AsyncLocalStorage` that the transport installs outside `handleRequest`.

If progress went through the journal, one of two results would occur.
The payload type would weaken to `Record<string, unknown>` at the wire boundary, or the journal envelope would become part of the RPC protocol.
Both results are worse than the status quo.
Progress also writes unredacted today, so journal-boundary redaction would silently alter wire bytes.

Therefore, this ADR does not change `packages/host-kit/src/internal/request-progress.ts`, `request-progress-protocol.ts`, or the two transports.
A future feature can need progress events in the journal (for example, a request timeline).
In that case, the correct shape is a **mirror emit**: the progress emitter also emits a cataloged journal kind.
The correct shape never reroutes the wire path through the journal.
That is a separate, opt-in decision.

### 4. First planned consumer: the usage sink (privacy by construction)

The consumer that motivates this architecture is opt-in **usage analytics over agent behavior**.
It observes which commands run, how often they run, what fails with which error codes, and outcome sequences that cause agents to fail.
Examples of these sequences are consecutive full snapshots, screenshot-after-snapshot, and repeated same-command failures.
The unit of observation is request **metadata**, never request **content**.

Therefore, the privacy rule is **allowlist by construction, not redaction**.
Redaction is a blocklist over rich data, and one missed field leaks a selector or label.
Instead, the usage sink projects `session-lifecycle` events into a closed `UsageRecord` schema.
Every field in that schema draws from an enumerated vocabulary:

- `command`/action: enumerated by the CommandDescriptor registry;
- outcome: `ok` or the typed error **code** (ADR 0010's closed set), never the error message;
- `durationMs`, cost fields (`runnerRoundTrips`, `nodeCount`), `platform`/`appleOs`;
- flag **names** present on the request, never flag values;
- a hashed session identity plus a per-session sequence number, so command bigrams are computable downstream.

Positionals, selectors, labels, fill text, snapshot content, and error messages are unrepresentable in the schema.
Thus there is nothing to scrub.
Sequence/anti-pattern detection is downstream analysis over the record stream, never emission-side logic.
A local stats read comes first, and an opt-in export comes later.
The sink itself is a follow-up that comes after migration step 3, because it consumes the `session-lifecycle` kinds.
This ADR fixes only the schema discipline of the sink, so that nobody builds a richer interim export.

## Invariants

- **Byte compatibility, one declared exception.**
  The sinks produce `events.ndjson` v1, per-request diagnostics ndjson, `replay-timing.ndjson` shapes and legacy `type` discriminators, and `cost.runnerRoundTrips` identically.
  Golden fixtures under `contracts/fixtures/` pin each format.
  The declared exception: replay-timing events from the previously unredacted helper become redacted.
  URL query stripping, sensitive-key masking, and long string truncation may alter those lines.
  This is an intentional security fix, and it ships as one: the changelog shows it, and the fixture is updated.
  It is not an unnoticed side effect.
- **Single redaction boundary for journal-owned outputs.**
  `redactDiagnosticData` runs once, on append.
  The flush path's second whole-entry pass is retained only until sinks own their writes.
  Then it is removed.
  No sink may write an event that did not pass through the journal.
  (Progress is not journal-owned, and it keeps its current unredacted wire behavior.)
- **Emitters never branch on consumers.**
  An emit site must not know or care whether debug mode or a replay trace is active.
  All consumer-conditional logic lives in the sink.
- **No state from events.**
  The journal is write-only telemetry.
  This ADR rejects the recovery of session state, replay provenance, or repair watermarks from journal events.
  That recovery is out of scope (see Alternatives).
- **Traits over names.**
  No production code may select events by a match on kind-name substrings (`startsWith('ios_runner_')` and similar).
  A lint-style test enforces this for the derived-set helpers.

## Consequences

- To trace a request, filter the journal by `requestId` (or by `session` for teardown scopes).
  One envelope and one ordering cover what are today three telemetry files with different envelope shapes.
  Progress remains separately observable on the wire, as an operational channel should be.
- New observability features (a timeline command, an OTel exporter, a perf-phase report) are new sinks.
  They need no new emit sites and no new vocabularies.
- A new event kind needs a catalog entry plus emit sites.
  If you forget the catalog entry, that is a compile error.
  If the owning sink maps an internal kind, a rename of that kind is invisible on the wire.
  A change to a **wire** name remains a breaking change for log consumers, and it needs the same care as today.
- The dead `traceLogPath` option, the duplicate redaction pass, and the unredacted replay-timing helper are deleted.
  Replay-timing redaction is the one visible output change.
- Cost: a mechanical, wide migration.
  About 70 files import the typed kind.
  The string values themselves do not change, so diffs are type-level.
  Runtime overhead is one synchronous sink-dispatch loop per event, in addition to today's buffer push.
  This overhead is negligible against device I/O.

## Alternatives considered

- **Absorb progress streaming into the journal** (the first draft's step 5): rejected after review.
  Progress is a transport-owned output port with ordering, cancellation, and closed-union type-safety requirements.
  To reroute it through a generic journal weakens a protocol contract and gives no operational gain.
  Mirror emits remain available if journal visibility is ever necessary.
- **One closed discriminated union with typed payloads per kind:** rejected for this ADR.
  155 kinds × payload schemas is a large, low-yield migration.
  After the catalog exists, payload types can be added per kind, one at a time.
  The catalog is the enforcement point.
  Payload typing is a follow-up, not a prerequisite.
  (Progress keeps its typed union precisely because it stays on its own channel.)
- **`EventEmitter`/pub-sub bus:** rejected.
  Implicit subscription defeats both goals:
  deletability (who listens is not statically visible) and traceability (causality disappears into `.on()`).
  The codebase currently has zero production `EventEmitter` usage, and this design keeps it that way.
- **Event sourcing (rebuild session state from the journal):** rejected.
  Session state has owners (`SessionStore`, ref frames, repair transactions) with their own invariants and gates.
  To derive session state from telemetry would couple correctness to an observability channel.
  It is also a large behavioral rewrite with no user-facing benefit.
- **A process-global fallback scope instead of explicit teardown scopes:** rejected.
  An ambient catch-all scope would make "which scope did this event land in" environment-dependent, and it would hide missing-scope bugs.
  Teardown entry points are few and known, so explicit scopes are cheap.
- **Leave the channels, just type the phases:** considered as a stopping point.
  Step 1 alone fixes the stringly agent-cost coupling.
  But it leaves the duplicate envelopes, the redaction inconsistency, and three write paths.
  Instead, this ADR keeps it as the first independently useful step of the migration.
- **Merge `upload-progress` and `app-events` in:** rejected.
  Upload progress is a local byte-counter callback that never crosses the request scope.
  `packages/daemon/src/execution/app-events.ts` is a deep-link builder for the `trigger-app-event` command, not an event channel.

## Validation required for implementation

- Type-level completeness: an emit with an uncataloged kind fails to compile.
  Orphan detection (declared-but-never-emitted kinds) is **static**.
  A source-scan check in the layering-lint style proves that every catalog kind has at least one emit reference.
  Runtime observation is explicitly not the mechanism, because it conflates untested branches with dead declarations.
- Golden byte-compatibility fixtures for `events.ndjson`, the per-request diagnostics file, and `replay-timing.ndjson`.
  The `replay-timing.ndjson` fixture is updated once, in the same change that declares the redaction fix.
- Out-of-request coverage: an idle-reap/shutdown `finalizeRepairTeardown` still writes its synthesized `close` as an `action.recorded` entry in `events.ndjson`.
  It does this through a teardown scope, with no request active.
- Retention: the size cap (#1788) is orthogonal to sink ownership, but it shares the file.
  A sink migration keeps these properties:
  - Rotation stays inside the one serialized write path.
  - The sidecar is written before the rename that it describes.
  - Reads fail typed (`EVENT_LOG_CURSOR_EXPIRED` / `EVENT_LOG_WINDOW_UNVERIFIED`) and do not answer a cursor that they cannot place.
- Per-attempt routing: a multi-attempt `test` run writes the trace of each attempt to its own file with legacy `type` values.
  Trace-kind events emitted with no bound destination are dropped, not misrouted.
  A **concurrent nested-action regression** runs sharded attempts in parallel.
  Each attempt does nested dispatch that rebinds `session`/`logPath` through `createRequestExecutionScope`.
  The regression proves per-fork isolation across **all three routed outputs**:
  each `replay-timing.ndjson`, each per-request diagnostics ndjson, and each session's `events.ndjson` plus its retained generation contain only the events of their own shard.
  There are no cross-writes and no drops, including for events emitted after `await` points.
- Sink isolation: a sink that throws does not affect the buffer, other sinks, or the response.
  Ordering across sinks is registration order.
- `cost.runnerRoundTrips` parity: the trait-derived set equals the current literal list.
  The existing `request-router-cost` test keeps passing unchanged.
- Redaction: a fixture proves that a sensitive value emitted in `data` never reaches any journal-owned sink output, including the replay timing trace.
- Usage schema gate: a type/test check proves the vocabulary source of every `UsageRecord` field.
  A field is either numeric, an enum imported from the owning registry (command names, error codes, flag keys), or a hash.
  The check also proves that no open-string field exists.
  A new open-string field is a failing gate, not a review comment.
- Layering: `scripts/layering/check.ts` stays green.
  The catalog is in `contracts`, the runtime is in `host-kit`, and there are no new back-edges.

## Migration plan

Each step passes all checks when it merges, and each step is independently useful:

1. **Catalog + typed kinds**:
   introduce `EVENT_CATALOG`, and narrow `emitDiagnostic`'s `phase` to `EventKind`.
   Migrate all emit sites mechanically (string values unchanged).
   Derive `RUNNER_ROUND_TRIP_PHASES` from the `runner-round-trip` trait with a parity test.
   Add the static orphan check.
   There is no runtime behavior change.
2. **Sink seam**:
   restructure `diagnostics.ts` so that the scope owns an explicit sink list with the ordering/isolation/flush contract.
   Move the debug stream and agent-cost tally behind it.
   Delete `traceLogPath`.
   Collapse to a single redaction pass.
   Add the byte-compat fixtures in this step.
3. **Session event log as sink + teardown scopes**:
   request-lifecycle emit points route through the journal.
   The `events.ndjson` writer becomes a sink.
   Idle-reap/shutdown finalizers open session-scoped teardown scopes, so out-of-request `action.recorded` events continue.
   The `events` command keeps its paging contract.
   This includes the typed cursor-expiry and window-verification errors that the #1788 retention window added to it.
4. **Replay trace as sink**:
   add the journal fork primitive together with its concurrent-shard regression.
   One sink with fork-bound per-attempt routing and legacy `type` mapping replaces both trace helpers.
   The declared redaction change ships in this step with its fixture and changelog entry.
