# ADR 0014: Session Ref-Frame Lifetime

## Status

Accepted. Enforcement applies across all platforms.

Completed process history is in git history.

Fresh live evidence exercised every production seam except Android blocking-dialog recovery.
That seam has an accepted evidence gap because no deterministic procedure can raise the system dialog on demand.
Fixture regressions fix the expected transition and abort behavior in `android-system-dialog-ref-frame.test.ts` and `interaction-touch-android-readiness.test.ts`.

## Rules at a glance

[Decision](#decision) contains the binding contracts and edge cases.
`CONTEXT.md` defines ref-frame vocabulary.

- A session owns at most one **ref frame**, separate from its latest operational observation, `session.snapshot`.
  The frame holds an epoch exposed as `refsGeneration`, immutable source tree, `active`/`expired` state, and `all` or bounded issuance scope.
  It is one value on `SessionState`.
  Transitions replace it whole and never edit it in place.
  Nominal `#`-private fields prevent construction, edits, or derivation outside `packages/daemon/src/core/ref-frame.ts`.
  The field-owner gate covers unchanged whole-frame moves, including field clearance and assignment from another session.
- A complete snapshot activates an `all` frame.
  `find`, settled diffs, and replay divergence screens activate bounded partial frames that supersede the prior frame.
  Internal read-only captures never activate, reindex, or expire a frame.
- Every mutating leaf expires the frame after pre-action guards, immediately before the device operation.
  No success-only rollback occurs.
  Post-dispatch failure leaves the frame expired.
- Mutation admission requires an active frame whose epoch and issuance scope authorize the ref.
  Typed rejection reasons have this order:
  1. `ref_frame_expired`.
  2. `ref_generation_mismatch`.
  3. `plain_ref_requires_complete_frame`.
  4. `ref_not_issued`.
- Read-only refs remain fail-open with structured staleness warnings only while retained frame evidence can resolve them.
  Missing evidence fails instead of resolving against a newer observation by positional coincidence.
- Every daemon command declares `RefFrameEffect` (`preserve` | `may-invalidate` | `delegated`) in its descriptor daemon facet.
  A completeness gate enforces registry classification.

## Context

Snapshot refs such as `@e12` are positional names inside one accessibility-tree namespace.
They are inexpensive and effective within that namespace.
They do not identify an element across navigation, layout changes, or captures with different positional order.
A generation pin such as `@e12~s42` identifies the issuing namespace.
It does not stabilize the element.

The session model combines two distinct concepts in `session.snapshot`:

1. The latest operational observation for selector matches, verification, settled observations, Android freshness, overlays, and diagnostics.
2. The caller-authorized tree whose refs may authorize later mutations.

This combination causes failures in both directions.
A mutation can change the device without another capture, so old positional refs appear current.
An internal read-only capture can replace `session.snapshot` and invalidate refs despite no caller mutation.
Partial `find` results, settled diffs, and replay divergence screens can clear the coarse stale marker for a whole tree after exposing few refs.

Issue [#1239](https://github.com/callstack/agent-device/issues/1239) and PR [#1241](https://github.com/callstack/agent-device/pull/1241) demonstrate the first failure on iOS.
`snapshot -> press @e1 -> press @e2` can dispatch both presses if the first press takes no internal capture.
The second ref uses pre-action coordinates even if the first press navigated.
A false successful tap on a new screen is worse than an explicit stale-ref failure.

The lifetime contract must meet these requirements:

- Be consistent across platforms and dispatch paths.
- Preserve fast paths.
- Remain compatible with selector-based replay.
- Add no automatic capture or per-node output bytes.

## Decision

The terms below define the implemented model and appear in `CONTEXT.md`.
The coarse `snapshotRefsStale` marker is removed.
Read-only ref staleness derives from frame state.
A plain ref warns after frame expiry.
Read-only captures do not mark refs stale because they do not expire the frame.

### Ref frames are separate from operational observations

A session owns at most one **ref frame**.
This authorization namespace for mutation refs contains:

- A seeded monotonic **ref-frame epoch**, exposed as `refsGeneration` and accepted through `~s<n>`.
- The immutable source tree required to resolve and guard issued refs.
- State `active` or `expired`.
- Issuance scope `all` or a bounded set of issued ref bodies.

Operational captures update the latest observation for selectors and diagnostics.
They do not silently replace, reactivate, or reindex the authorized ref frame.
The implementation may share immutable tree objects between observation and frame.
It must not combine their lifetimes through mutable session-state aliases.

Only one frame is retained.
A new active frame supersedes the previous frame and advances the epoch.
No historical generation-to-tree cache is introduced.
Complete and partial frames retain the immutable source tree.
Interaction guards and replay identity can depend on ancestors, siblings, overlays, and viewport context outside emitted nodes.
The issuance set bounds partial authority, not the evidence tree.
If frame and observation originate from the same capture, they share immutable capture data.
Neither transition deep-copies the tree.

The existing `snapshotGeneration` implementation evolves behind one ref-frame module.
Its former companion `snapshotRefsStale` is removed.
For wire compatibility, public `refsGeneration` and `@e12~s42` grammar remain unchanged.

### Frame transitions

| Event | Frame transition | Plain refs | Pinned refs |
| --- | --- | --- | --- |
| Internal observation that returns no refs | None | Unchanged | Unchanged |
| Complete frame activation | New active epoch, scope `all` | Accepted from this frame | Accepted when epoch matches |
| Non-empty partial publication | New active epoch, scope = emitted refs | Rejected | Accepted only for an emitted ref at this epoch |
| First possible device-side effect | Advance once to `expired` | Rejected | Previous epoch rejected |
| Additional effects while already expired | Idempotent | Rejected | Rejected |
| Sparse, failed, or unusable capture | None | Unchanged | Unchanged |
| Session reopen | New random-seeded lifetime | Rejected until publication | Old lifetime rejected probabilistically as today |

Complete activation normally accompanies a result that exposes the stored frame's complete ref namespace.
This includes interactive or intentionally scoped snapshots.
An intentionally scoped snapshot replaces authorization with exactly its returned namespace.
It neither authorizes matching ref bodies outside the scope nor retains the old `all` scope.

Before a frame-activating capture uses an `@ref` scope, it must admit that ref against the active frame.
Scoped output reindexes refs.
To preserve repeated scoped snapshots, the session retains one bounded **scope lineage** for consecutive read-only repetitions of that exact scope.
The lineage stores the admitted semantic scope as label/selector chain.
It stores neither the old positional tree nor mutation authority.
Repeated `snapshot -s @ref` may use lineage only if the immediately preceding frame publication was the same scoped capture.
These events clear lineage:

- The first device-side effect.
- Unrelated frame publication.
- Another scope.

Arbitrary stale or unissued scope refs fail closed.
They cannot use lineage or authorize another subtree.
Empty, sparse, failed, or unusable repetitions preserve the last useful frame and still-consecutive lineage.
Selector-scoped captures retain normal selector rules.

These outputs are partial external publications:

- Snapshot diffs.
- Digests that omit the namespace.
- `find`.
- Settled diffs/tails.
- Replay divergence screens.

They activate partial frames only if the caller or orchestrated workflow sees at least one ref and its epoch.
An empty partial result does not supersede useful authority.
Partial publication intentionally supersedes the prior frame.
This avoids unbounded generation-specific trees and makes authority explicit.
Only refs named in that response can authorize mutations, with the response-level epoch.

An explicit non-diff complete snapshot leaf may activate a frame inside replay or batch before the outer orchestrator returns.
This remains true if the outer response later omits or digests the tree.
This execution-local exception preserves deterministic `snapshot -> @ref` scripts.
It authorizes only predeclared later bare-ref steps.
It does not:

- Publish pins to the outer caller or MCP.
- Make the outer response ref-issuing.
- Add general result interpolation.

Internally injected, cached, freshness, and recovery captures never receive this exception.
Nested non-empty partial publication may supersede scope.
However, batch and replay have no dynamic generation binding for a later step to consume it.

### Mutation admission and read behavior

A ref mutation is admitted only if all conditions hold:

1. The frame is active.
2. A pin names the current epoch, or a plain ref targets a complete `all` frame.
3. The ref body belongs to the issuance scope.
4. Normal target guards and replay target-binding verification pass.

Resolution uses the authorized frame, never positional coincidence in a newer operational observation.
Android freshness captures may verify current identity or provide comparison evidence.
They must not redefine the node authorized by an already-admitted `@eN`.

Read-only ref consumers remain fail-open with structured staleness warnings only if retained frame evidence can resolve the ref.
A stale read is observable and recoverable.
A stale mutation can affect the wrong element.
Missing evidence fails instead of using positional coincidence in a newer observation.
Reads never reactivate frames or give unissued refs mutation authority.

Rejected mutations use the existing error system.
Admission evaluates typed reasons in this order:

1. `ref_frame_expired`: a side effect invalidated the current frame.
2. `ref_generation_mismatch`: a pin names another epoch.
3. `plain_ref_requires_complete_frame`: a plain ref targets a partial frame.
4. `ref_not_issued`: a pin is outside a partial frame's issuance set.

These reasons distinguish a need for complete snapshot capture from a need for an emitted pinned ref.
Each failure includes `details.ref`, `details.reason`, `details.currentGeneration`, and frame scope.
Pinned inputs also include `details.mintedGeneration`.
For example:

```text
code: COMMAND_FAILED
message: Ref @e12 belongs to an expired ref frame
details.reason: ref_frame_expired
details.ref: @e12
details.currentGeneration: 43
details.mintedGeneration: 42  # present only when the input was pinned
hint: Capture a fresh interactive snapshot or use a stable selector.
```

The daemon cannot truthfully report `mintedGeneration` for a plain ref.
If lifetime expiry caused failure, error messages must not claim that an existing ref was missing or lacked bounds.

### Expiration occurs at the side-effect seam

Expiry occurs after all pre-action guards pass, including:

- Syntax.
- Capability.
- Freshness.
- Target resolution.
- Replay identity.
- Occlusion.
- Visibility.
- Bounds.

It occurs immediately before the first operation that may change device-visible element identity.
Before awaiting that operation, persist the in-memory transition.

Pre-seam failure preserves the frame.
After the seam, success, timeout, cancellation, connection loss, and ambiguous platform errors all leave it expired.
The device may already have acted.
The seam also clears scoped-snapshot lineage.
No success-only rollback occurs.

This rule covers every execution shape:

- Runtime ref/selector/coordinate paths expire before `tap`, `fill`, `longPress`, text input, or gesture execution.
- Native web ref paths perform ref preflight, then expire before `clickRef` or `fillRef`.
- Direct iOS selector paths consume no ref but expire existing frames before the fused runner resolve-and-act request.
- Platform-generic, app lifecycle, keyboard, alert, settings, and provider actions expire at their actual leaf side-effect seam.
  They do not expire at generic admission.
- Existing-session `open`/relaunch expires that session's frame before first close/launch dispatch.
  Post-dispatch failure or timeout leaves it expired.
  Successful `close` deletes the session, with no frame to restore.
- After an error, fallback or retry may proceed only if the error proves no prior side effect.
  Ambiguous post-dispatch errors neither restore the frame nor authorize an automatic second action.
- Android blocking-dialog recovery mutates the device.
  Before recovery tap/relaunch, it must cross the same idempotent seam, even during apparent readiness work.
  If recovery mutates before a requested ref action dispatches, that action aborts with `ref_frame_expired`.
  It cannot continue against the recovered UI.
  Selector and coordinate actions may re-resolve and continue under existing policies.

The seam intentionally belongs inside leaf execution.
Router-entry expiry would reject the current command's ref, invalidate ordinary validation failures, and mishandle multiplexed or orchestrating commands.

Some operations combine final status/target checks and mutation in one request.
Examples include direct iOS selectors and current native alert or keyboard actions.
Until a lower-level “will act” callback exists, fused-request dispatch is the conservative seam.
Later `not found`, `already hidden`, timeout, or no-alert results do not restore the frame.
A separate definitive read-only status request preserves the frame if it proves no mutation request was dispatched.

### Command effects are daemon-owned and completely classified

The command descriptor's daemon facet declares request policy:

```ts
type RefFrameEffect = 'preserve' | 'may-invalidate' | 'delegated';

type DaemonRefFrameEffect = RefFrameEffect | ((request: DaemonRequest) => RefFrameEffect);
```

The daemon registry exposes a named resolver.
Every daemon command is classified.
Classification checks honesty/completeness, not transitions.
`may-invalidate` means some successful path can cross a device side effect.
Only after that path is selected does the leaf call the ref-frame module.
Request-sensitive commands use a focused resolver instead of one classification for all subcommands.

The registry is the exhaustive source of truth.
This non-exhaustive table guides representative classifications.
It must not become a second prose registry:

| Effect | Commands/actions |
| --- | --- |
| `may-invalidate` | press, click, fill, longpress, type, focus, scroll, swipe, gesture, back, home, `tv-remote`, orientation, open/relaunch, trigger/push delivery, settings changes, install/reinstall, React Native overlay dismissal, and lifecycle operations that can replace the visible surface |
| Conditional resolver | keyboard status preserves; dismiss/return/input invalidate. Alert get/wait preserve; accept/dismiss invalidate. Find reads preserve; click/fill/focus/type delegate to leaf mutation. |
| `delegated` | batch, replay, and test/suite orchestrators; each nested leaf owns its transition |
| `preserve` | snapshots and other observation, assertion, screenshot, recording, trace, logs, events, network inspection, performance, inventory, capability, lease, and transport-management operations, unless a selected subaction directly manipulates the visible surface |

Clipboard reads and writes preserve the frame because pasteboard state alone does not change element identity.
A later paste/type action invalidates independently.

Generic routes have no exception.
`back`, `home`, `orientation`, `scroll`, `tv-remote`, and `app-switcher` must cross the transition in the generic daemon leaf when they act.
The completeness gate covers every daemon-projected command, including generic fallbacks.
Thus, a missing facet cannot hide an unclassified mutation.
Mutations from unrelated external tools remain outside this session guarantee.

Runner-side classification does not define this policy.
Apple runner traits govern retry eligibility, launch policy, and recorded-failure conversion at a lower wire-command boundary.
The TypeScript `readOnly` trait controls:

- Read-only resend.
- Session-invalidation skip.
- Transport error classification.
- Readiness preflight.

`refFrameEffect` governs daemon session authorization, including commands outside the Apple runner.
Narrow consistency tests may cover direct mappings.
Blanket parity would combine distinct concepts.

The existing per-session request lock serializes frame admission and transitions.
The frame is shared session state, not per-client or per-lease history.
Generation pins identify rejected epochs and reasons precisely.
They neither reserve frames nor prevent another caller's mutation from expiring them.
No second ref-specific mutex is introduced.

### Batch, replay, recording, and repeated actions

Batch and replay invoke sequential steps through ordinary daemon dispatch and declare `delegated`.
Outer command start never expires a frame.
Frame state passes naturally between leaves:

- `snapshot -> press @e1 -> press @e2` executes the first press and rejects the second.
- `snapshot -> press @e1 -> press @e1 -> press @e2` stops on the second press, before `@e2`.
- `snapshot -> press @e1 -> snapshot -> press @e2` is admitted.
- Selector-only and coordinate-only batches retain their request-round-trip advantage.
- Stale-ref failure stops batch under existing policy.
  It preserves `step`, `command`, `executed`, `total`, `partialResults`, diagnostics, and `details.reason`.

Batch gains no nested MCP pin traversal, intermediate-result interpolation, unsafe ref-stability override, or second static lifecycle interpreter.
Normal leaf dispatch is the sole enforcement path.

Recorded `.ad` scripts remain selector-first.
The recorder converts successfully resolved refs to selector chains.
It refuses to persist unresolved session-bound bare refs.
Generation suffixes remain runtime evidence and are removed from durable recordings because seeded epochs are not portable across sessions.
Legacy handwritten `.ad` scripts that mutate several bare refs from one snapshot become intentionally incompatible.
They must capture between mutations or use selectors.
Replay target-binding verification finishes before the seam.
Identity divergence preserves the frame.
Post-dispatch action failure leaves it expired.

These repetitions form one logical command:

- `press --count`.
- Double-tap.
- Hold.
- Jitter.
- `swipe --count`.
- Platform sequence chunks.

They resolve or plan once and expire once before the first repetition.
Every repetition executes the original physical point/plan.
They neither re-resolve the target nor reactivate the frame between repetitions.
Later repetition or chunk failure leaves the frame expired.
This preserves explicit repeated physical actions while preventing frame reuse by later commands.

### Partial issuance and MCP

`find`, settled diffs/tails, and replay divergence screens publish only returned refs.
They must not mark the whole frame as issued.

Read-only `find` may partially publish its returned ref.
Mutating `find` returns its acted ref only as diagnostic pre-action identity.
It must omit `refsGeneration`.
It must not publish or activate a frame.
It cannot validate that ref after the nested action.

The MCP executor retains per-ref pins by state-directory/session scope.
Issuance must distinguish the selected `find` action instead of command name alone.
Read-only `find` with `refsGeneration` merges its partial pin.
Mutating `find` without `refsGeneration` is explicitly non-issuing and leaves remembered pins unchanged.
It must not enter a generic missing-generation branch that clears the session's pin scope.
The executor must carry sufficient normalized command/action context for this distinction.
Mutation does not clear remembered pins.
The old epoch lets the daemon return a precise stale rejection.
MCP neither traverses nested batch input refs nor learns refs from nested batch results.
Both remain explicit non-goals.

Response-level `refsGeneration` retains authority without repeated per-node bytes.
Snapshot nodes never gain generation bytes.
Every reusable partial CLI text ref must render as ready-to-copy `@eN~s<refsGeneration>`.
JSON and Node.js retain plain ref bodies with one response-level generation.
Before mutation, callers must pair them.
MCP may render plain refs because it stores and forwards pins internally.
Complete snapshot trees remain plain to preserve the token budget.
A mutating `find` diagnostic ref never renders or stores as pinned because it has no `refsGeneration`.

## Performance and compatibility

Expiry is O(1): one monotonic epoch transition and bounded in-memory state.
It adds no capture, platform request, daemon round trip, or per-node output.
At most one authorized frame and one latest operational observation remain retained.
They share immutable capture objects without deep copies.
The model never caches unbounded full-tree history.
Existing capture size limits remain the bound.
Memory pressure must not silently expire or replace frames.
Otherwise, deterministic admission would depend on the environment.

The intentional cost affects workflows.
Several ref mutations may require explicit observations between them.
Callers can avoid unnecessary captures through:

- Selectors.
- Direct selector fast paths.
- A pinned emitted ref from settled partial output.
- `--count` for repeated physical actions at one target.

The daemon never auto-captures only to renew refs.

Older clients remain wire-parse-compatible.
Command grammar, `refsGeneration`, and `~s<n>` remain unchanged.
Structured error details are additive, so ADR 0006 requires no protocol increment.
Behavioral compatibility is incomplete:

- Unsafe plain-ref mutation chains now fail.
- Fused commands can expire frames despite eventual no-op results.
  Examples include already-hidden `keyboard dismiss` and alert actions with no alert.
- Read-only refs without retained evidence fail instead of warning and resolving by positional coincidence in newer observations.

These changes require CLI/help, changelog, `.ad` migration, and batch guidance.

This contract composes with existing ADRs:

- ADR 0003/0008: daemon-owned effect policy composes in the descriptor daemon facet and projects only through the daemon registry.
- ADR 0004: capture plans and sparse-quality rules remain unchanged, with no added capture.
- ADR 0005: runner liveness/preflight remains independent of ref authorization.
- ADR 0006/0010: no RPC increment; typed `details.reason` and actionable hints follow the error contract.
- ADR 0007: frames use the existing session/request lock, outside client/lease-local state.
- ADR 0009: Apple, Android, Linux, and web share one target model with projected public platform output.
- ADR 0011: lifetime spans session sequences instead of another element-guarantee cell.
  Every mutating path still crosses the shared seam.
- ADR 0012: durable target identity retains selectors/evidence; divergence refs issue bounded partial authority.
- ADR 0013: coordinate gestures expire frames but remain outside the element guarantee matrix.

## Consequences

- Stale refs cannot silently mutate a different element after navigation.
  Typed failure requires a fresh observation or selector.
- Multiple logical ref mutations require captures between them, issued settled refs, selectors, or one repeated-action command such as `--count`.
  Legacy handwritten `.ad` scripts that reuse bare refs from one snapshot must change.
- Conservative fused requests may consume authority even if the platform reports no required action.
  This prioritizes prevention of wrong-screen actions over ref preservation after ambiguous dispatch.
- Reads without retained evidence fail instead of using positional coincidence in newer trees.
  Reads with retained evidence preserve structured warnings.
- Consecutive scoped snapshots retain admitted semantic scope.
  Mutation, unrelated publication, or another scope clears lineage.
- Bounded session-memory bookkeeping adds no automatic capture, platform call, round trip, or per-node response bytes.

## Required evidence

Completion requires contract and provider tests that prove:

1. After an unobserved first mutation, bare and pinned second mutations reject.
2. Definitive pre-seam validation, target, and replay-identity failures preserve the frame.
3. Timeout, cancellation, connection loss, and other post-seam failures leave it expired.
4. Every listed path crosses the same seam: runtime ref/selector/coordinate, native ref, direct selector, provider-backed interaction, and provider-backed lifecycle/generic paths.
5. Android freshness cannot retarget admitted refs by positional coincidence.
6. Read-only operational captures do not replace authorized frames.
7. Partial publication admits only emitted pinned refs and reports each typed failure.
   It cannot authorize unrelated plain refs.
   CLI text pins every reusable partial ref.
   JSON and Node.js retain response-level representation.
8. Complete publication admits its plain namespace.
   Sparse/unusable captures do not.
9. Mutating `find` omits `refsGeneration` and never pins or activates its pre-action ref as post-action state.
   After MCP remembers a snapshot pin and performs mutating `find`, later ref input still forwards the old pin.
   The daemon rejects it as stale.
10. Batch and replay delegate per step and retain failure/partial-result contracts.
    They permit `snapshot -> @ref` with an intermediate digest without exposed pins or dynamic bindings.
11. Recorded scripts contain selectors instead of portable generation claims.
12. Press/swipe series and Apple chunks resolve and expire exactly once.
13. Android dialog recovery expires before its first side effect.
    After recovery mutates, it aborts an outstanding ref action.
14. Consecutive `snapshot -s @ref` calls resolve the same admitted semantic scope after ref reindex.
    Mutation, unrelated publication, or another scope clears lineage.
    Arbitrary stale refs cannot use it.
    Empty/unusable repetitions preserve the last useful frame and still-consecutive lineage.
15. Fused keyboard/alert and split status/action requests follow their conservative seams, including already-hidden and no-alert outcomes.
16. Failed or timed-out existing-session open/relaunch leaves the old frame expired after dispatch.
17. Read-only refs with retained stale evidence return structured warnings.
    Missing evidence fails without positional fallback to newer observations.
18. A large-tree fixture proves that frame/observation separation adds no deep copy.
    It records bounded peak retained nodes/bytes.
19. Enforcement and error shapes are consistent across supported platforms.

Performance regression tests prove that admission, expiry, and frame/observation separation add no implicit capture or provider/platform call.
Device benchmarks are required only if tests or live evidence reveal regression.
No path may claim success until a test proves execution of the relevant direct/native/runtime/provider branch.

Before platform enforcement, fresh-build live evidence must exercise every affected supported production seam:

- Apple runtime-ref and direct/native paths where available.
- Android helper freshness and recovery.
- Generic/lifecycle mutation.
- At least one real provider-backed interaction and lifecycle operation.

Every run must prove:

1. A fresh ref succeeds.
2. A second mutation with the stale ref rejects before dispatch.
3. A fresh observation restores usability.

Unexercised seams remain disabled or explicit release blockers.
Fixture tests and registry claims are necessary but do not replace live evidence.

## Alternatives considered

- **Stable refs across trees.** Rejected because positional snapshots have no durable cross-tree identity.
  Semantic IDs are neither universal nor unique.
- **Expire only after successful mutation.** Rejected because the device may act before timeout or transport failure.
- **Use one snapshot for observation and authorization.** Rejected because internal read-only captures can reindex or invalidate caller refs.
- **Automatically capture after every mutation.** Rejected because it adds the dominant platform cost and can fail or return sparse output.
  It hides lifetime instead of defining it.
- **Retain every generation's full tree.** Rejected as unbounded memory unnecessary for one current frame.
- **Immediately add per-ref history.** Rejected until evidence requires concurrent generations.
  One bounded current frame and issuance scope suffice.
- **Derive policy from runner traits.** Rejected because runner traits classify wire commands for remaining app work.
  Daemon ref authorization classifies their effects on the frame.
- **Add batch interpolation or unsafe ref-stability overrides.** Rejected as new orchestration interfaces that bypass the safety rule.
- **Put lifetime in ADR 0011's element path matrix.** Rejected because lifetime spans commands, time, non-element invalidators, and orchestrators.
  The matrix retains per-path element guarantees.
