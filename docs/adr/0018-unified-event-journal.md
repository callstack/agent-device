# ADR 0018: Unified Request Event Journal

## Status

Partly accepted.
The session event log contract is accepted and implemented in `packages/session-journal/src`: `events.ndjson` v1 entries, size-capped rotation to one retained generation, the verifying retention-window sidecar, and the typed `EVENT_LOG_CURSOR_EXPIRED` and `EVENT_LOG_WINDOW_UNVERIFIED` cursor errors of the `events` command.
Out-of-request work, such as the idle sweep and lease session end, runs in the daemon-level diagnostics scope (`session: 'daemon'`), not in a per-session teardown scope.
The rest of this record remains proposed (2026-07-24) and is not implemented: the event catalog, the single journal append point, registered sinks, forked scopes with parent scope identity, and the usage record.
The proposed names below (`EVENT_CATALOG`, `EventKind`, `UsageRecord`, `parentScopeId`) do not exist in code.
The [pre-slimming text](https://github.com/callstack/agent-device/blob/e35d0d496fb820d57d95fcad1b6b62dfa9962abb/docs/adr/0018-unified-event-journal.md) is historical context only: its inventory and step order are not current guidance.

## Context

Diagnostics, the session event log, and replay timing use separate event vocabularies, envelopes, and write paths.
Their redaction disciplines differ.
Agent-cost counts runner round trips through a hand-picked list of diagnostic phases, which can drift.
An opt-in usage analytics consumer motivates a shared vocabulary with a strict metadata-only privacy boundary.
ADR 0008 uses a declaration registry and derived projections for commands.
This proposal applies that approach to observability events.

Progress streaming is a separate transport output port.
It has ordering and interleaving guarantees with the final response, tracks client disconnects for cancellation, and uses a closed typed union.
It is opt-in through `meta.requestProgress`, disabled under `--json`, and currently unredacted.
Upload progress is a local callback outside request scope.
Neither belongs to the proposed journal.

## Proposal

### Catalog and ownership

A single `EVENT_CATALOG` in the contracts package would declare every diagnostic and telemetry kind, its subsystem, default level, and derivation traits.
`EventKind` would be `keyof typeof EVENT_CATALOG`, and `subsystem` and `level` would be closed unions.
`emitDiagnostic` would accept `EventKind` rather than `string`, so an uncataloged emit would fail to compile.
Existing diagnostic phase strings would enter the catalog verbatim.
Payloads would remain `Record<string, unknown>`; typed per-kind payloads are a possible follow-up.
The catalog would also include session lifecycle and replay trace kinds.
Internal catalog keys need not equal legacy wire or file discriminators.
Each sink would map internal keys to the exact legacy `kind` or `type` values.

Consumers would derive kind sets from traits, never from parsed names.
Exactly `ios_runner_command_send` and `ios_runner_readiness_preflight` would carry `runner-round-trip`.
Their `_skipped` and `_recovered` variants would not.
A parity test would pin the derived sets.
The contracts package would own the catalog and host-kit would own the journal runtime, preserving import direction.

### Journal, scopes, and sinks

The diagnostics scope would become the single journal append point for diagnostics, agent-cost tallies, session lifecycle events, and replay traces.
On append, the journal would stamp `ts`, `requestId?`, `session?`, and `command?`, redact `data`, buffer the event, and tally `phaseCounts` before offering it to sinks.
Emitters would state facts without branching on consumers.
All consumer-conditional logic would live in the sink.
No sink may write an event that did not pass through the journal.

The existing request scope would remain, including CLI entry, daemon request handling, and fatal catch-all.
Idle reap and daemon shutdown would open explicit short-lived session-scoped teardown scopes without a `requestId`.
A teardown-recorded `close` action must continue to produce an `action.recorded` entry when no request is active.

Sinks would be explicitly registered at scope construction, with no dynamic subscription.
Each entry point would list its sinks in one place, statically enumerable.
The journal would invoke them synchronously in registration order.
Each invocation would be best-effort: a sink error would be swallowed and must not affect the buffer, other sinks, or the request.
A sink may queue its own I/O.
Flush would remain journal-owned, preserving `flushDiagnosticsToSessionFile` semantics.
Buffered sinks would expose flush hooks called at request finalization and on fatal paths.

Concurrent shard and attempt work, including nested replay dispatch, would run in forked scopes.
A fork would clone every mutable binding, including the envelope, `logPath`, and routing, apply its frozen bindings, and own and flush its buffer against those bindings.
Only the sink list and concurrency-safe aggregation state would be shared.
The `phaseCounts` tally would remain request-global so agent-cost spans shards.
`updateDiagnosticsScope` would mutate only the current scope, and each mid-flight rebind would affect that shard's clone.
The attempt trace binding would end with the fork; trace events with no bound destination would be dropped.
This would prevent cross-routing between parallel nested dispatches.

Each request, teardown, and fork scope would carry a `scopeId` in its event envelope.
A fork would also carry its parent's `scopeId` as `parentScopeId`, so a future exporter could emit parent-child spans from envelope fields alone, without changing the envelope or emit sites.
Cross-process correlation would remain `requestId`.
An exporter and a W3C `traceparent`-style request metadata field are deferred to a later ADR.

The proposed sinks would have these responsibilities:

- The debug stream sink would preserve the existing live writer and `liveWrittenEventCount` flush watermark.
- The session event log sink would consume `session-lifecycle` kinds, retain the existing presentation builders and serialized write queue, and write `events.ndjson` v1.
  Rotation would remain size-capped to one retained generation.
  The retention window's sidecar, on which `events` cursor identity depends, would record each retained generation's first absolute line index, line count, and first-line digest.
  The reader would verify these values against the files before answering.
  The sidecar would not be a cache and cannot be regenerated from entries.
  A sink that owns the file also owns this contract.
- The replay trace sink would consume `replay-trace` kinds, map legacy `type` values, and use the bound per-attempt destination in place of both append helpers.
- Agent-cost would derive its existing `phaseCounts` projection from the `runner-round-trip` trait.

Session state remains owned by its stores.
`recordActionEntry` would still push to `session.actions` first, and `action.recorded` would remain a projection of that push.
The journal would be observability, not a source of truth.
Session state, replay provenance, and repair watermarks must not be rebuilt from events.

### Progress and usage

Progress streaming would remain unchanged and transport-owned.
Its typed wire serializer and cancellation behavior would not pass through the generic journal.
If a future feature needs journal visibility, it can separately opt in to a mirror emit of a cataloged kind; the wire path must not be rerouted.

Anything that would leave the machine must go through the closed `UsageRecord` schema.
A later opt-in usage sink would project `session-lifecycle` events into a closed `UsageRecord`.
It would use an allowlist by construction, not redaction of rich data.
Its fields would be command or action from the CommandDescriptor registry; `ok` or a typed error code from ADR 0010's closed set; `durationMs`, `runnerRoundTrips`, `nodeCount`, `platform`, and `appleOs`; flag names without values; and a hashed session identity with a per-session sequence number.
Positionals, selectors, labels, fill text, snapshot content, and error messages would be unrepresentable.
Sequence and anti-pattern detection would be downstream, never emission-side.
A local stats read would come first and opt-in export later.
The sink would follow the session lifecycle migration; this proposal fixes its schema discipline only.

### Compatibility and redaction

The proposed sinks would preserve the bytes and shapes of `events.ndjson` v1 entries, per-request diagnostics ndjson, replay timing traces and their legacy `type` values, and `cost.runnerRoundTrips`, with one exception.
Replay timing events from the currently unredacted helper would become redacted.
URL query stripping, sensitive-key masking, and long string truncation may change those lines.
The change would be declared in the changelog and its fixture updated.

Journal-owned outputs would be redacted once at append.
The second whole-entry flush pass would remain only until sinks own their writes, then be removed.
Progress would keep its current unredacted wire behavior.
A wire name change remains a breaking change for log consumers, even though an internal kind rename can be invisible on the wire.

## Validation required for implementation

- An uncataloged emit must fail to compile.
  Static source scanning, not runtime observation, must detect catalog kinds with no emit reference.
- Golden fixtures must pin the existing formats and the declared replay redaction change.
- Idle reap and shutdown must preserve the out-of-request `close` action through a teardown scope.
- Rotation must remain in the serialized write path, and the sidecar must be written before the rename it describes.
  Reads must fail with `EVENT_LOG_CURSOR_EXPIRED` or `EVENT_LOG_WINDOW_UNVERIFIED` when they cannot place a cursor.
- A multi-attempt `test` run must write each attempt trace to its own file with legacy `type` values.
  An unbound trace event must be dropped.
  A concurrent nested-action regression must run sharded attempts in parallel with nested dispatch that rebinds `session` and `logPath`, and prove shard isolation for replay traces, per-request diagnostics, and each session event log including its retained generation, without cross-writes or drops, including for events emitted after `await` points.
- Tests must verify sink ordering, error isolation, and parity of the runner-round-trip trait with the current literal list.
- A redaction fixture must prove that sensitive `data` reaches no journal-owned output.
- Byte-compatibility fixtures must exist before any sink owns a write.
- The fork primitive must land with its concurrent-shard regression.
- The replay redaction change must ship in one change with its fixture update and changelog entry.
- A type or test gate must prove every `UsageRecord` field is numeric, an enum from its owning registry, or a hash, and reject open-string fields.
- Production code must not select events by kind-name substrings; a lint-style test would enforce this for the derived-set helpers.
  Layering checks must preserve the contracts and host-kit ownership boundary without back-edges.

## Alternatives considered

- Absorb progress into the journal: rejected because a generic journal would weaken the payload type or put its envelope into the RPC protocol, and redaction would change unredacted wire behavior.
  A separate mirror emit remains possible.
- A closed discriminated union with typed payloads for every kind: rejected for this migration because the large schema conversion has low yield.
  Payload typing can follow per kind.
- An `EventEmitter` or pub-sub bus: rejected because implicit subscriptions hide listeners and causality.
- Event sourcing: rejected because correctness would depend on telemetry and existing state owners have their own invariants.
- A process-global fallback scope: rejected because it makes scope selection environment-dependent and hides missing-scope bugs.
- Type phases without unifying channels: rejected as a stopping point and kept as the first migration step, because alone it leaves duplicate envelopes, inconsistent redaction, and three write paths.
- Merge upload progress or app events: rejected because the former is a local byte-counter callback and the latter is a deep-link builder, not an event channel.

## Consequences

The proposed journal would support request tracing by `requestId` and teardown tracing by `session`, while progress remains observable on the wire.
New observability consumers could use sinks without new vocabularies or emit sites.
The migration would remove the duplicate redaction pass and the unredacted replay helper.
The `traceLogPath` option stays until its callers move to the replay trace sink.
Replay redaction would be the declared visible output change.
The migration would be wide and would add one synchronous sink-dispatch loop per event.

The `events` command would retain its paging contract, including typed cursor-expiry and window-verification errors.
