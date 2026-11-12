# ADR 0039: Pre-dispatch admission for resolved targets

## Status

Accepted.
This record owns the checks that run after an interaction target is resolved and before input is sent.
It narrows how [ADR 0011](0011-interaction-guarantee-contract.md) paths declare those checks. It keeps the frame rules of [ADR 0014](0014-session-ref-frame-lifetime.md), the plan rules of [ADR 0013](0013-unified-gesture-plans.md), and the dispatch ledger.
[#4456](https://github.com/callstack/agent-device/issues/4456) holds the migration plan.

## Context

Pre-dispatch checks let an action report success only when the intended control could receive the input. They reject a target that is still moving, a covered target, a point inside a system bar, and a control that a fading view still blocks.

These checks have no owner.
The moving-target gate runs only for runtime-resolved press and click; long-press, fill, hover and drag skip it.
Its waits ignore the request deadline and cancellation signal (`packages/command-runtime/src/commands/runtime-common.ts`).
Each new check adds its own loop, evidence carrier, clone patch and refusal reason. Recent proposals for iOS native readiness and Android system-bar bounds both did.
The state that decides the outcome is implicit: object identity between captures, closures, private side tables, and the `deferredSurface` baseline that one request leaves for the next.

## Decision

**One owner.** Command runtime has one admission step for resolved targets.
Every interaction whose target the daemon resolves calls it between resolution and the backend call: press, click, long-press, double-tap, hover, fill, and each endpoint of a target-authored drag.
The native-ref and direct iOS selector paths dispatch without daemon resolution, so admission does not apply to them. They keep their ADR 0011 path rows.
The static resolution guards (visibility, parent-owned touch point, covered annotation) stay with their shared owner and run first. Admission uses their result.

**Typed checks.** Admission runs an ordered list of checks over one evidence bundle. Today the list is motion, then readiness.
Each check returns pass, wait or refuse. A refusal has a typed reason; unknown geometry, a covered target, an ambiguous native binding and a native read failure stay distinct.
Each interaction's ADR 0011 path row declares which checks apply, their policy, and the maximum extra reads on the accept path.

**One loop, one budget.** All admission waiting happens in one loop. Its hard bound is the earliest of the request execution deadline, the result deadline and any intent cap.
The loop checks cancellation and the bound before and after every read, before every sleep, and immediately before dispatch.
Transition windows start once; a retry does not restart them.
The loop uses the observation engine in `packages/capture-kit/src/observe-until.ts` with a hard bound that no verdict or minimum poll count can extend. Other users of that engine keep its soft budget.
While only a live fact blocks, the loop polls that fact alone. When a fact or the geometry changes, the dependent checks run again on fresh evidence before dispatch.

**Evidence.** Platform facts reach admission as typed private evidence, owned by `packages/contracts/src/snapshot-private-evidence.ts`.
One operation builds, copies and remaps that evidence through projection and cloning. No check or store adds its own side table or clone patch.
A live probe result is separate evidence with its own producer, surface and generation. It never counts as part of an older capture.

**Cost.** A target is idle when no earlier mutation left a motion baseline in `deferredSurface`.
On the accept path, an idle target adds no capture, probe or sleep.
A live probe, such as iOS native hittability, runs only for a target that is not idle.

**Unchanged rules.** Frame admission and its error precedence come first (ADR 0014). Ref expiry stays immediately before the leaf side effect.
Pinned replay and find targets, repeated-action plans and system sheets keep their current rules.
A refusal before any send reports `dispatched: no`. A failure after a send reports what the ledger recorded.

## Rejected alternatives

- **One stage for all input, with admitted-only backend signatures.** Raw points, native refs, coordinate gestures, and keyboard and remote input have no resolved target. The stage would add captures they do not need and break guarantees in ADR 0011, 0013, 0014 and 0031.
- **Path declarations alone.** Declaring order and cost in ADR 0011 shows the gaps but keeps two wait loops and two target matchers on the press path.
- **A fused native tap-if-authorized as the readiness design.** It can shorten the gap between read and tap on iOS. It does not help waiting on other platforms, and element hittability still does not prove that the point receives the input. It stays a separate optimization, adopted only when measured.
- **One more check for each new bug.** This is the current pattern; the paths keep drifting apart.

## Consequences and open gaps

The moving-target gate's waits move into admission. No other wait loop exists for these interactions.
Long-press, fill and hover gain the motion check, and their accept-path latency must not grow. A daemon-resolved double-tap already has the check through the press path.
Target-authored drag runs admission without the motion check. ADR 0011 marks its target stability as inapplicable, because re-pointing one endpoint would split the gesture plan.
An overlay that the app shows on its own timer, with no earlier mutation, is not detected on an idle press. This is the trade-off of the cost rule, and the gate already has the same blind spot.
Partial custom covers (#4347) and safe regions for coordinate-authored trajectories stay open. Admission gives them a place but does not solve them.
