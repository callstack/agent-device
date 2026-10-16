# ADR 0018: Unified Request Event Journal

## Status

Proposed (2026-07-24; revised the same day after architecture review).
Nothing here is implemented.

The reviewed proposal has less scope than the first draft.
Progress remains a permanent transport-owned output channel, separate from telemetry.
The journal would combine diagnostics, agent-cost, session events, and replay timing traces.
Explicit scopes cover out-of-request session events.
Replay-trace redaction is a declared compatibility change, not byte-compatible behavior.

## Rules at a glance

This ADR proposes these rules; full contracts and rationale follow:

- One **event catalog**, `packages/contracts/src/events.ts`, declares each diagnostic/telemetry kind's key, subsystem, default level, and derivation traits.
  An uncataloged emit is a compile error.
  Consumers derive kind sets from traits, never from kind-name parsing.
- Catalog keys are **internal identities**.
  Sinks map them to unchanged legacy output discriminators, including diagnostics `phase` and replay `type`.
  A wire name does not automatically become the canonical identity across channels.
- One **journal per scope** provides the only append point through an evolved `emitDiagnostic`.
  Existing request scopes remain.
  Explicit short-lived session teardown scopes cover idle reap and shutdown, following fatal-scope precedent.
  Emitters state facts without consumer knowledge.
  There is no `EventEmitter` or dynamic subscription.
- Scope construction registers each **sink** explicitly.
  Sinks run synchronously in registration order.
  Each invocation suppresses its own errors without effects on other sinks or requests.
  Concurrent work uses forked scopes that clone mutable envelope, log-path, and routing bindings.
  Only concurrency-safe aggregation state is shared as mutable state.
- **Progress remains transport-owned.** `src/request/progress.ts` and its typed `RequestProgressEvent` union do not change.
- **Existing formats remain byte-compatible, with one exception.** Golden fixtures preserve `events.ndjson` v1, `cost.runnerRoundTrips`, per-request diagnostics ndjson, and replay-timing shapes.
  The currently unredacted replay-timing helper's events become redacted.
  This intentional security fix is a declared behavior change.
- **One journal boundary redacts every journal-owned output.**
- **The journal owns observability, not application truth.** Existing stores retain `session.actions` and all other session state.
  Events never reconstruct that state.
- Machine-external output uses a **closed allowlist schema**, the usage sink's `UsageRecord`.
  Registry-enumerated metadata and durations are representable.
  Positionals, selectors, labels, and messages are unrepresentable by type, rather than merely redacted.

## Context

The 2026-07-24 inventory identifies four parallel event vocabularies.
Each has separate emit calls, shapes, redaction rules, and sinks:

1. **Diagnostics**, `packages/host-kit/src/internal/diagnostics.ts`, has about 155 string-typed `phase` values in about 70 files.
   Three entry points establish `AsyncLocalStorage` request scopes:
   CLI pre-parse, daemon per-request `request-router.ts`, and the daemon fatal catch-all.
   Diagnostics has an in-memory buffer and `phaseCounts` tally.
   Debug mode streams to per-request ndjson after `createRequestExecutionScope` rebinds `logPath`, or to `daemon.log`/stderr.
   No caller sets `traceLogPath`; that option is unused.
2. **Session event log**, `@agent-device/session-journal/session-event-log`, appends per-session `events.ndjson`.
   Kinds are `request.started`, `request.finished`, and `action.recorded`.
   Three request-lifecycle points and `SessionStore.recordAction` write it.
   Only public `events` reads it.
   `action.recorded` already projects `session.actions` pushes, which this proposal generalizes.
   Some appends occur outside requests.
   `finalizeRepairTeardown` in `packages/daemon/src/core/session-store.ts` records synthetic `close` during idle reap or shutdown.
   Its comment states "no live request here."
3. **Progress streaming**, `src/request/progress.ts` and `src/daemon/request-progress-protocol.ts`, uses a closed typed `RequestProgressEvent` union.
   Socket/HTTP transport installs single-sink `AsyncLocalStorage`.
   Ndjson envelopes share the final-response stream.
   Client disconnect feeds cancellation.
   `meta.requestProgress` explicitly enables the channel per request.
   `--json` disables it.
   Current wire events are **unredacted**.
4. **Replay timing trace**, `src/daemon/handlers/session-replay-trace.ts` and `session-test-runtime.ts`, uses per-attempt `replay-timing.ndjson` files.
   Each attempt creates its path dynamically.
   `src/cli/replay-test/trace.ts` reads them.
   Two helpers write them: `appendReplayTraceEvent` and `appendReplayTestTimingEvent`.
   Only one redacts.

`src/upload-progress.ts` is a fifth local callback sink for artifact uploads.
It never crosses request scope and remains out of scope.
Production has no `EventEmitter` usage.
The proposal preserves that avoidance of implicit pub/sub.

The channels overlap without a common envelope or kind vocabulary.
Consumers depend on strings at emit sites.
For example, agent-cost computes `runnerRoundTrips` with `countDiagnosticEventsByPhase(['ios_runner_command_send', 'ios_runner_readiness_preflight'])` in `packages/daemon/src/server/request-router.ts`.
A new runner phase can silently escape this manually selected list.
No owner enumerates round-trip phases.
Selection also violates the repository rule that categories come from recorded fields, not parsed names.

The immediate motivation is opt-in analytics for command frequency, failure codes, and outcome sequences that cause agent difficulty.
Privacy requires request metadata only, never content (decision 4).
ADR 0008 uses one command declaration registry with parity-tested projections.
This proposal applies the same method to telemetry events.
Progress remains separate under decision 3.

## Decision

### 1. Event catalog: kinds are declared data

This section proposes one `EVENT_CATALOG` const object in `packages/contracts/src/events.ts`.
Each kind has one entry.
Existing diagnostics phase strings remain unchanged as keys:

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

`emitDiagnostic`'s `phase` narrows from `string` to `EventKind`.
Uncataloged emits fail compilation, as with ADR 0011's completeness mechanism.
The approximately 155 phases enter verbatim.
Per-kind `data` remains `Record<string, unknown>`.
Typed payload schemas can follow incrementally; they are not a prerequisite.

Other channels receive catalog entries, including these legacy discriminators:

- Session `request.started`
- Session `request.finished`
- Session `action.recorded`
- Replay `replay_action_start`
- Replay `replay_action_stop`
- Attempt-lifecycle events

Internal keys need not equal those discriminators.
The owning sink maps each internal kind to exact legacy `kind`/`type` output.
Consumer wire/file names remain fixed.
Internal identities can remain consistent independently.

Consumers derive sets through traits.
`RUNNER_ROUND_TRIP_PHASES` becomes `kindsWithTrait('runner-round-trip')`.
Only `ios_runner_command_send` and `ios_runner_readiness_preflight` have that trait.
Their `_skipped`/`_recovered` variants deliberately do not.
This preserves existing cost semantics.
A parity test fixes the derived sets so a trait edit requires review.

The catalog belongs to ranked, kernel-adjacent `contracts`.
All zones can import it without a layering back-edge.
Runtime evolves in `packages/host-kit/src/internal/diagnostics.ts` with existing legal import directions.

### 2. One journal, explicit sinks, defined scope model

This section proposes the diagnostics scope as the **journal**.
It is the sole append point for diagnostics, agent-cost tallies, session lifecycle events, and replay traces.
`emit(event)` retains existing operations:

1. Stamp `ts`, `requestId?`, `session?`, and `command?` from the scope envelope.
2. Redact `data`.
3. Buffer the event.
4. Tally `phaseCounts`.
5. Offer the event to each registered sink.

**Scope model.** Two explicit scope forms apply:

- Existing per-request scopes remain unchanged at CLI entry, daemon `handleRequest`, and fatal catch-all.
- Short-lived session teardown scopes cover idle reap and shutdown finalizers, including `finalizeRepairTeardown` and session cleanup.
  They bind a session without `requestId`, following `emitFatalDiagnostic` precedent.
  This permits teardown's synthetic `close` event without bypassing the journal.
  The existing out-of-request `SessionStore.recordAction` append must continue.
  Silent omission is unacceptable.

**Sink contract.** Each entry point lists sinks at scope construction.
The list is statically enumerable and searchable.
There is no dynamic subscription API.
The proposed normative semantics are:

- **Ordering:** invoke sinks synchronously at emit time, in registration order.
  A sink may queue its own I/O.
  Session logging retains its per-path serialized write queue.
- **Isolation:** suppress each sink's error independently.
  It must never affect another sink, the buffer, or the request.
  This follows current diagnostic stream writes.
- **Flush:** journal ownership and `flushDiagnosticsToSessionFile` semantics remain unchanged.
  Buffered sinks expose hooks for journal finalization and fatal paths.
- **Concurrency:** use `journal.fork(bindings, fn)` instead of shared rebinding.
  It runs `fn` in a new `AsyncLocalStorage` scope object.
  The fork clones every mutable envelope field (`session`, `command`, `debug`), `logPath`, and routing binding.
  It applies its own frozen `bindings` and owns a separate buffer.
  Fork completion flushes against its own bindings.
  Only the sink list and concurrency-safe aggregation state remain shared.
  Request-global `phaseCounts` uses single-threaded atomic increments because agent-cost must include every shard.

Concurrent `test` attempts use `Promise.allSettled` in `runReplayTestShards` (`src/daemon/handlers/session-test.ts`).
Nested dispatch invokes `createRequestExecutionScope` in `request-router.ts` child scopes.
It rebinds `session` and `logPath` during execution.
A shared mutable envelope could route debug and session-log events to another shard, even with frozen trace bindings.
Thus, `updateDiagnosticsScope` changes only the innermost current scope.
Every shard/attempt wraps its complete lifecycle, including nested replay dispatch, in a fork.
All rebindings affect that clone.
Its trace destination ends with the fork.
No separate clearing step can race.
The trace sink drops trace-kind events without a destination.

**Scope identity:** each request, teardown, and fork scope has `scopeId`.
Forks also carry `parentScopeId`.
Both enter the event envelope.
The existing fork tree then permits future exporters, such as OpenTelemetry, to produce parent-child spans without emit-site or envelope changes.
Cross-process correlation remains `requestId`, already present on both RPC sides.
A W3C `traceparent`-style request-meta field would be additive under ADR 0006.
It is deferred to an exporter ADR.
This ADR includes no exporter.

**Registered sinks:**

- **Debug stream:** existing debug ndjson output uses per-request files, `daemon.log`, or stderr fallback.
  Behavior and the `liveWrittenEventCount` flush watermark remain unchanged.
- **Session event log:** consumes `session-lifecycle` traits and writes byte-identical `events.ndjson` v1 entries.
  It reuses `buildActionSummary`, `buildRequestSuccessEventPresentation`, the write queue, and the #1788 retention window in `session-event-log-window.ts`.
  Size-capped rotation retains one generation, `events.ndjson.1`.
  The cap does not change entry bytes.
  `events.ndjson.window.json` is journal-owned state required for cursor identity, not a cache.
  It records each retained generation's first absolute line index, line count, and first-line digest.
  Before answers, readers verify those values against files.
  A sink that owns the sidecar also owns this contract.
  Entries cannot reconstruct it.
- **Replay trace:** consumes `replay-trace` traits, maps legacy `type`, and writes to the bound per-attempt path.
  It replaces both append helpers.
- **Agent-cost tally:** existing `phaseCounts` projection derives its kind set from `runner-round-trip`.

Existing direct calls to `sessionStore.recordEvent`/`appendActionEvent` become journal emits.
The affected lifecycle points are `request-execution-scope.ts`, `request-router.ts`, and `session-store.ts`.
The sink owns file output.
`SessionAction` recording remains unchanged.
`recordActionEntry` still pushes `session.actions` first.
`action.recorded` remains a projection of that push.

### 3. Progress streaming stays a separate, transport-owned channel

This section proposes no change to progress transport.
Progress is a transport **output port** with these requirements:

- Ordering and interleaving with the final response on the same stream
- Disconnect tracking for cancellation
- Closed typed `RequestProgressEvent` input to the wire serializer
- Single-sink `AsyncLocalStorage` installed outside `handleRequest`

A journal route would weaken payloads to `Record<string, unknown>` or place the journal envelope in the RPC protocol.
Neither improves current behavior.
Current progress is unredacted, so boundary redaction would also silently change wire bytes.

`src/request/progress.ts`, `request-progress-protocol.ts`, and both transports therefore remain unchanged.
If a future feature needs journal progress visibility, the progress emitter can additionally emit a cataloged journal kind.
It must not route the wire path through the journal.
Such **mirror emits** require a separate explicit decision.

### 4. First planned consumer: the usage sink (privacy by construction)

This section proposes schema discipline for a future opt-in usage sink.
It observes command frequency, typed failures, and problematic outcome sequences.
Examples include consecutive full snapshots, screenshot-after-snapshot, and repeated same-command failures.
Observation uses request **metadata**, never content.

A closed allowlist schema prevents content representation.
Redaction alone risks a missed field in rich data.
The sink projects `session-lifecycle` events into `UsageRecord` with these permitted fields:

- Command/action from the CommandDescriptor registry
- Outcome `ok` or a typed error code from ADR 0010's closed set, never a message
- `durationMs`, cost fields (`runnerRoundTrips`, `nodeCount`), and `platform`/`appleOs`
- Present flag names, never values
- Hashed session identity and per-session sequence number for downstream command bigrams

Positionals, selectors, labels, fill text, snapshot content, and error messages cannot be represented.
Sequence/anti-pattern detection occurs downstream over records, never during emission.
Local statistics come first; explicit export follows later.
The sink remains follow-up work after migration step 3 because it consumes `session-lifecycle` kinds.
This ADR fixes only schema discipline to prevent an interim richer export.

## Invariants

This proposal requires these invariants:

- **Byte compatibility with one declared exception.** Sinks preserve `events.ndjson` v1, per-request diagnostics, replay-timing shapes/legacy `type`, and `cost.runnerRoundTrips`.
  Golden fixtures in `contracts/fixtures/` fix each format.
  Events from the formerly unredacted replay helper become redacted.
  URL-query removal, sensitive-key masking, and long-string truncation can change those lines.
  The security fix requires updated fixtures and a changelog entry.
- **One redaction boundary.** `redactDiagnosticData` runs once at append for journal-owned output.
  The second whole-entry flush pass remains only until sinks own their writes.
  It is then removed.
  No sink may write an event that bypasses the journal.
  Transport-owned progress retains unredacted wire behavior.
- **No consumer-dependent emitters.** Emit sites must not depend on debug mode or active replay traces.
  Consumer conditions belong to sinks.
- **No state reconstruction.** Journal events are write-only telemetry.
  Session state, replay provenance, and repair watermarks must not be recovered from them.
- **Traits instead of name parsing.** Production code must not select kinds through name substrings such as `startsWith('ios_runner_')`.
  A lint-style test enforces this for derived-set helpers.

## Consequences

If accepted and implemented, this proposal would have these consequences:

- Traceability filters the journal by `requestId`, or `session` for teardown.
  One envelope and order replace three telemetry-file envelope shapes.
  Progress remains separately observable on the wire.
- Timelines, OTel export, and performance-phase reports become sinks without new emit sites or vocabularies.
- New kinds require catalog entries and emits.
  Missing entries fail compilation.
  Internal renames are wire-invisible when sinks map them.
  Wire renames remain breaking changes for log consumers.
- Unused `traceLogPath`, duplicate redaction, and the unredacted replay helper are removed.
  Replay-timing redaction is the only visible output change.
- Migration affects about 70 files through typed kinds without string-value changes.
  Runtime adds one synchronous sink-dispatch loop per event to existing buffering.
  That cost is negligible relative to device I/O.

## Alternatives considered

This proposal evaluates these alternatives:

- **Absorb progress: rejected after review.** Transport ordering, cancellation, and closed-union safety require its separate output port.
  A generic journal weakens that protocol without operational benefit.
  Mirror emits remain possible.
- **Typed payload union for all kinds: rejected for this ADR.** About 155 payload schemas create a large migration with limited benefit.
  The catalog is the enforcement boundary.
  Payload types can follow per kind.
  Progress retains its typed union on its own channel.
- **`EventEmitter`/pub-sub: rejected.** Implicit subscriptions hide consumers and causality in `.on()`.
  This harms deletion analysis and traceability.
  Production currently has no `EventEmitter`, and the proposal preserves that.
- **Event sourcing: rejected.** `SessionStore`, ref frames, and repair transactions already own state invariants and gates.
  Telemetry-based reconstruction couples correctness to observability and requires a broad behavior rewrite without user benefit.
- **Process-global fallback scope: rejected.** Ambient scope selection depends on environment and conceals missing-scope defects.
  Teardown entry points are few and known, so explicit scopes are inexpensive.
- **Type phases only: retained as migration step 1.** It independently removes string-based agent-cost coupling.
  As a final design, it leaves duplicate envelopes, inconsistent redaction, and three write paths.
- **Include `upload-progress` and `app-events`: rejected.** Upload progress is a local byte-counter callback within request scope.
  `packages/daemon/src/execution/app-events.ts` builds deep links for `trigger-app-event`; it is not an event channel.

## Validation required for implementation

Before this proposal can be implemented successfully, validation must prove these properties:

- Uncataloged emits fail compilation.
  A static source scan, in layering-lint style, proves an emit reference for every kind.
  Runtime observation is not orphan detection because untested branches are not dead declarations.
- Golden fixtures preserve `events.ndjson`, per-request diagnostics, and replay timing bytes.
  The replay fixture changes once with the declared redaction fix.
- Without an active request, idle-reap/shutdown `finalizeRepairTeardown` emits synthetic `close` as `action.recorded` through a teardown scope.
- Retention #1788 remains within the one serialized write path.
  The sidecar precedes the rename it describes.
  Unplaceable cursors fail with typed `EVENT_LOG_CURSOR_EXPIRED` / `EVENT_LOG_WINDOW_UNVERIFIED` instead of an unverified answer.
- Each attempt writes its own trace with legacy `type` values.
  Trace-kind events without destinations are dropped instead of misrouted.
  A concurrent nested-action regression exercises parallel shards and nested `createRequestExecutionScope` session/log-path rebindings.
  Each replay trace, diagnostics file, session event log, and retained generation contains only its shard's events.
  There are no cross-writes or omissions, including after `await`.
- A throwing sink affects neither buffer, other sinks, nor response.
  Sinks retain registration order.
- Trait-derived `cost.runnerRoundTrips` kinds equal the existing literal list.
  Existing `request-router-cost` tests pass unchanged.
- Sensitive `data` never reaches any journal sink, including replay timing.
- Every `UsageRecord` field is numeric, a registry-owned enum, or a hash.
  The gate rejects open-string fields.
  Enum sources include command names, error codes, and flag keys.
- `scripts/layering/check.ts` passes with catalog in `contracts`, runtime in `host-kit`, and no new back-edges.

## Migration plan

This active proposal plans independently useful steps that each pass validation:

1. **Catalog and typed kinds.** Introduce `EVENT_CATALOG` and narrow `emitDiagnostic.phase` to `EventKind`.
   Migrate emits without string changes.
   Derive `RUNNER_ROUND_TRIP_PHASES` from its trait with parity coverage.
   Add static orphan detection.
   Runtime behavior remains unchanged.
2. **Sink boundary.** Add scope-owned sink lists with ordering, isolation, and flush contracts.
   Move debug streaming and agent-cost behind that boundary.
   Delete `traceLogPath`.
   Use one redaction pass.
   Add byte-compatibility fixtures.
3. **Session sink and teardown scopes.** Route lifecycle emits through the journal and make the event-log writer a sink.
   Add idle-reap/shutdown session scopes to preserve out-of-request actions.
   Preserve `events` paging and #1788's typed cursor-expiry/window-verification errors.
4. **Replay sink.** Add fork scopes and the concurrent-shard regression.
   Replace both helpers with one fork-routed sink and legacy `type` mappings.
   Deliver the declared redaction fix with its fixture and changelog entry.
