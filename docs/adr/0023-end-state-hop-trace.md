# ADR 0023: Entry-to-platform hop audit

## Status

Reference audit for ADR 0019 and ADR 0022.
The [ordered traces](https://github.com/callstack/agent-device/blob/0e7df74a1ad724e1deff07ff57f8ec763c883d21/docs/adr/0023-end-state-hop-trace.md) and measurements describe commit `27a97ee619`.
They are not a current file map.

## Decision

Count each distinct production TypeScript file entered on the main call path once, including both endpoints.
Do not count type-only imports, files that supply only types, side-calls, response-only files, or forks outside the trace.
Trace the snapshot runner fallback with an existing runner session.
Assign each file one role: policy, orchestration, translation, adapter, or pass-through.

Apply the deletion test to each pass-through or translation hop.
A hop is a collapse candidate only if its caller, callee, or both can inline its handoff without losing admission, budget, isolation, an ADR boundary, or a testability seam.
The test evaluates the hop, not whether the file can be deleted.

The audit supersedes the earlier 38/29 counts and the target of at most 14 hops.
At the measured commit, the Android `press` route had 41 hops and the iOS `snapshot` primary and fallback routes had 47 and 49 respectively.
The audit proved one thin command-binding hop removable; its collapse would reduce the snapshot counts to 46 and 48.
It endorsed only that reduction.
Any further target requires a decision to fold cross-cutting request-scope wrappers.

## Rationale

An ordered trace with a defined unit makes the count auditable.
A count alone does not show whether a hop owns a necessary boundary or responsibility.
The earlier counts had no ordered chain or counting definition, so the discrepancy could not be resolved.
The request spine, runtime bindings, and platform protocols retain responsibilities that a fixed target cannot remove by itself.

## Rejected alternative

Collapse every pass-through hop to reach at most 14 hops.
The deletion test found that the other audited pass-through hops retained depth or declared boundaries.

## Consequences

The counts are historical measurements, not a current budget or a claim about the current call path.
The daemon owns request admission and execution, the platform runtime registry owns runtime composition, and the platform packages own platform execution.
A new reduction must preserve their boundaries and apply the deletion test to its own trace.
