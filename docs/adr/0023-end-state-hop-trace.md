# ADR 0023: Entry-to-platform hop audit

## Status

Reference audit for the entry-to-platform hop counts in ADR 0019 and the coupling audit in ADR 0022.
The [ordered traces](https://github.com/callstack/agent-device/blob/0e7df74a1ad724e1deff07ff57f8ec763c883d21/docs/adr/0023-end-state-hop-trace.md) and measurements describe commit `27a97ee619`.
They are not a current file map.

## Decision

Count each distinct production TypeScript file entered on the main call path once, including both endpoints.
The path runs from the daemon HTTP entry to the file that issues the platform call.
For Android `press`, that call is the serial-scoped `adb shell input tap`.
For iOS `snapshot`, it is the AX bridge socket write on the primary arm, or the XCTest runner `fetch` on the fallback arm.
Follow only the first call that continues toward the platform call.
Do not count type-only imports, files that supply only types, side-calls, response-only files, or untraced forks.
Trace the snapshot runner fallback with an existing runner session.

Assign each file exactly one role: policy, orchestration, translation, adapter, or pass-through.
A pass-through hop delegates to exactly one next call on the path without a branch or transformation.
A translation hop maps values or shapes without issuing the platform call.
The pinned trace defines the other roles.

Apply the deletion test to each pass-through or translation hop.
A hop is a collapse candidate if its caller, callee, or both can inline its handoff without losing admission, budget, isolation, a boundary declared in an ADR, or a testability seam.
The test evaluates the hop, not whether the file can be deleted.

The audit supersedes the earlier 38/29 counts and the target of at most 14 hops.
At the measured commit, the Android `press` route had 41 hops, and the iOS `snapshot` primary and fallback routes had 47 and 49.
The audit proved one hop removable: the `bindRuntimeCommands` closure wrapper on the shared snapshot path.
Its collapse would reduce the snapshot counts to 46 and 48.
The audit endorses only that reduction.
Any further target requires a decision to fold cross-cutting request-scope wrappers.
That decision is outside the traced routes' ownership.

## Rationale

An ordered trace with a defined unit makes the count auditable.
A count alone does not show whether a hop owns a necessary boundary or responsibility.
The earlier counts had no ordered chain or counting definition, so the discrepancy could not be resolved.
The request spine, runtime bindings, and platform protocols retain responsibilities that a fixed target cannot remove by itself.

## Rejected alternative

Keep the target of at most 14 hops by folding every pass-through hop without kept depth.
Only one hop lacked kept depth.
For Android `press`, at most 14 hops would need the removal of 27 files with cross-cutting daemon responsibilities or necessary bindings.
Treat 14 as a historical discussion reference, not a derived number.

## Consequences

The counts are historical measurements, not a current budget or a claim about the current call path.
ADR 0022 owns the route-depth rule for new work.
