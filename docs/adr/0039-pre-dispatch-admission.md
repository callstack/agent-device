# ADR 0039: Pre-dispatch admission for resolved targets

## Status

Accepted.
This record owns the checks that run after an interaction target is resolved and before input is sent.
It narrows how [ADR 0011](0011-interaction-guarantee-contract.md) paths declare those checks. It keeps the frame rules of [ADR 0014](0014-session-ref-frame-lifetime.md), the plan rules of [ADR 0013](0013-unified-gesture-plans.md), and the dispatch ledger.
[#4456](https://github.com/callstack/agent-device/issues/4456) holds the migration plan.

## Context

Pre-input checks exist so that an action reports success only when the intended control could receive it. They reject a target that is still moving, a covered target, a point inside a system bar, or a control that a fading view still blocks.

There is no owner for this step.
The moving-target gate runs only for runtime-resolved press and click. Long-press, fill, hover and drag skip it.
Its waits ignore the request deadline and cancellation signal (`packages/command-runtime/src/commands/runtime-common.ts`).
Each new check brings its own place, loop, evidence carrier and refusal reason.
Proposals for iOS native readiness and Android system-bar bounds each add a separate loop or a private per-node carrier, and each patches the in-memory session clone to keep its facts.
State that decides the outcome is implicit: object identity between captures, closures, private side tables, and the `deferredSurface` baseline that one request leaves for the next.

## Decision

**One owner.** Command runtime has one pre-dispatch admission step for resolved targets.
Every interaction whose target the daemon resolves calls it between resolution and the backend call: press, click, long-press, double-tap, hover, fill, and each endpoint of a target-authored drag.
The native-ref and direct iOS selector paths dispatch natively without daemon resolution. Admission does not apply to them; they keep their ADR 0011 path rows.
Static resolution guards (visibility, parent-owned touch point, covered annotation) stay in their shared owner and run first. Admission consumes their result.

**Typed checks with declared policy.** Admission runs an ordered list of checks over one evidence bundle. Today the list is motion and readiness.
Each check returns pass, wait, or refuse with a typed reason. Unknown geometry, a covered target, an ambiguous native binding, and a native read failure keep distinct reasons.
Each interaction declares which checks apply and their policy in its ADR 0011 path row, with the maximum extra reads on the accept path.

**One budget and one loop.** All waiting in admission uses one loop under one hard bound: the earlier of the request execution and result deadlines, and any explicit intent cap.
The loop checks cancellation and the bound before and after every awaited read, before every sleep, and immediately before dispatch.
Transition windows are anchored once; a retry does not restart them.
The loop reuses the observation engine in `packages/capture-kit/src/observe-until.ts` with a hard bound that a verdict or minimum poll count cannot extend. Other consumers keep its soft budget.
While only a live fact is blocked, the loop polls that fact. When a fact or geometry changes, dependent checks run again on fresh evidence before dispatch.

**Evidence provenance.** Platform facts reach admission as typed private evidence, owned by `packages/contracts/src/snapshot-private-evidence.ts`.
One operation constructs, copies and remaps that evidence across projection and cloning. Checks and stores do not add side tables or per-field clone patches.
A live probe result is separate evidence with its own producer, surface and generation. It is never relabeled as part of an older capture.

**Cost.** A target is idle when no preceding mutation left a motion baseline in `deferredSurface`.
On the accept path an idle target pays no extra capture, probe or sleep.
A live probe, such as iOS native hittability, runs only for a target that is not idle.

**Preserved authority.** Frame admission and its error precedence stay first (ADR 0014). Ref expiry stays immediately before the leaf side effect.
Pinned replay and find targets, repeated-action plans, and system sheets keep their current rules.
A refusal before any send reports `dispatched: no`. A failure after a send reports what the ledger recorded.

## Rejected alternatives

- **One admission stage for every input, with admitted-only backend signatures.** Raw points, native refs, coordinate gestures, keyboard and remote input do not have a resolved target. The stage would add captures they do not need and would break ADR 0011, 0013, 0014 and 0031 guarantees.
- **Path declarations alone.** Declaring order and cost in ADR 0011 makes omissions visible but leaves two wait loops and two matchers on the press path.
- **Fused native tap-if-authorized as the readiness design.** It can shorten the gap between read and tap on iOS, but it does not solve waiting on other platforms and element hittability still does not prove the point receives input. It stays a separate, measured optimization behind the readiness check.
- **A check per PR, as today.** Each fix adds a loop, a carrier and a reason, and the paths drift apart.

## Consequences and open gaps

No wait loop for these interactions exists outside admission; the moving-target gate's schedules move into it. New pre-dispatch checks and platform facts join admission instead of adding their own loop or carrier.
Long-press, fill, hover and drag gain the motion check. Their accept-path latency must not grow.
An app-timed overlay that appears with no preceding mutation is not detected on an idle press. This is the cost rule's trade-off and matches the gate's existing blind spot.
Partial custom covers (#4347) and safe regions for coordinate-authored trajectories stay open. Admission gives them a place; it does not solve them.
