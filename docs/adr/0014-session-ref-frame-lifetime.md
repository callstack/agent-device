# ADR 0014: Session Ref-Frame Lifetime

## Status

Accepted.
This decision is implemented and enforced on `main` across all platforms.

Fresh live evidence exercised every production seam except Android blocking-dialog recovery.
Android blocking-dialog recovery shipped as a documented, accepted gap, because no deterministic repro exists to raise the system dialog on demand.
Fixture regressions pin the transition and abort logic of that seam: `android-system-dialog-ref-frame.test.ts` and `interaction-touch-android-readiness.test.ts`.

The staged migration plan is in the git history of this file.
PR #1241 was an earlier compatible transitional fix, not this architecture migration.

## Rules at a glance

This section is a normative summary.
[Decision](#decision) contains the binding contracts and edge cases.
The ref-frame vocabulary is promoted into `CONTEXT.md`.

- A session owns at most one **ref frame**.
  The ref frame is the authorization namespace for mutation refs.
  It is separate from the latest operational observation (`session.snapshot`).
  The frame holds an epoch exposed as `refsGeneration`, an immutable source tree, an `active`/`expired` state, and an `all` or bounded issuance scope.
  The frame is one value on `SessionState`.
  A transition replaces the frame whole and never edits it in place.
  The frame type is nominal (`#`-private fields).
  Thus, no module outside `packages/daemon/src/core/ref-frame-slot.ts` can construct the frame class directly, access its private fields, or edit a frame in place.
  Callers construct and derive frames only through the exported factory APIs `issuedRefFrame` and `expiredRefFrame`.
  `packages/daemon/src/core/ref-frame.ts` owns the transitions and admission that call these factories.
  The type cannot judge a whole frame that moves unchanged, for example when code clears the field or assigns the frame of another session.
  The field-owner gate still covers these moves.
- A complete snapshot activates an `all` frame.
  `find`, settled diffs, and replay divergence screens activate a bounded partial frame that supersedes the prior frame.
  A partial result with no issued ref does not supersede the prior frame.
  Internal read-only captures never activate, reindex, or expire a frame.
- Every mutating leaf expires the frame at the side-effect seam: after all pre-action guards, immediately before the device operation.
  There is no success-only rollback.
  A post-dispatch failure still leaves the frame expired.
- Mutation admission requires an active frame whose epoch and issuance scope authorize the ref.
  Rejections carry typed reasons in this order:
  1. `ref_frame_expired`.
  2. `ref_generation_mismatch`.
  3. `plain_ref_requires_complete_frame`.
  4. `ref_not_issued`.
- Read-only ref consumers stay fail-open with a structured staleness warning only while the frame retains the evidence of the ref.
  Missing evidence fails, instead of resolving by positional coincidence against a newer observation.
- Every daemon command declares a `RefFrameEffect` (`preserve` | `may-invalidate` | `delegated`) in its descriptor daemon facet.
  A completeness gate covers the registry classification.

## Context

Snapshot refs such as `@e12` are positional names inside one accessibility-tree namespace.
They are cheap and effective within that namespace.
But they do not identify an element across navigation, layout changes, or another capture whose positional order is different.
A generation pin such as `@e12~s42` identifies the namespace that issued the ref.
The pin does not make the element stable.

The current session model mixes two different concepts in `session.snapshot`:

1. The latest operational observation that selector matching, verification, settling, Android freshness, overlays, and diagnostics use.
2. The caller-authorized tree whose refs a later mutation may use.

This mix causes failures in both directions.
A mutation can change the device without another tree capture, so the old positional refs appear current.
Conversely, an internal read-only capture can replace `session.snapshot` and invalidate refs, even though the caller performed no mutation.
Partial outputs, such as `find`, settled diffs, and replay divergence screens, can then clear the coarse stale marker for the whole replacement tree.
They can do this even though they exposed only a few refs.

Issue [#1239](https://github.com/callstack/agent-device/issues/1239) and PR [#1241](https://github.com/callstack/agent-device/pull/1241) demonstrate the first failure on iOS.
`snapshot -> press @e1 -> press @e2` can dispatch both presses when the first press performs no internal capture.
The second ref is resolved against pre-action coordinates, even if the first press navigated.
A false successful tap on the new screen is worse than a clear stale-ref failure.

The lifetime contract must meet these requirements:

- Be consistent across platforms and dispatch paths.
- Preserve fast paths.
- Remain compatible with selector-based replay.
- Add no automatic capture or per-node output bytes.

## Decision

The terms that this section introduces are now the implemented model.
The ref-frame vocabulary is promoted into `CONTEXT.md`.
The superseded coarse `snapshotRefsStale` marker is removed.
Read-only ref staleness now derives from the frame state:

- A plain ref warns after the frame expires.
- A read-only capture no longer marks refs stale, because it does not expire the frame.

### Ref frames are separate from operational observations

A session owns at most one **ref frame**.
The frame is the authorization namespace for mutation refs.
It contains:

- A seeded, monotonic **ref-frame epoch**. The existing `refsGeneration` field exposes the epoch. The existing `~s<n>` input suffix accepts it.
- The immutable source tree that is necessary to resolve and guard the refs that the frame issued.
- A state of `active` or `expired`.
- An issuance scope of `all` or a bounded set of issued ref bodies.

Operational captures update the latest observation that selector and diagnostic machinery use.
They do not silently replace, reactivate, or reindex the authorized ref frame.
The implementation may share immutable tree objects between the observation and the frame.
But it must not make their lifetimes the same through aliases of mutable session state.

Only one frame is retained.
Activation of a new frame supersedes the previous frame and advances the epoch.
Historical generation-to-tree caches are not introduced.
Complete and partial frames retain the immutable source tree, because interaction guards and replay identity can depend on context outside the emitted subset.
This context includes ancestors, siblings, overlays, and the viewport.
The issuance set bounds partial authority; the evidence tree does not.
When the frame and the latest observation originate from the same capture, they share immutable capture data.
Neither transition deep-copies the tree.

The existing `snapshotGeneration` implementation evolves behind one ref-frame module.
The `snapshotRefsStale` marker that it originally paired with is now removed.
For wire compatibility, the public name `refsGeneration` and the `@e12~s42` grammar remain unchanged.

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

A complete activation normally accompanies a command result that exposes the complete ref namespace for the stored frame.
This includes an interactive or intentionally scoped snapshot.
An intentionally scoped snapshot replaces authorization with exactly its returned namespace.
It neither authorizes matching ref bodies outside that scope nor retains the old `all` scope.

A frame-activating capture scoped by `@ref` must first admit that scope ref against the current active frame.
Scoped output reindexes refs.
To preserve the existing contract for repeated scoped snapshots after this reindex, the session retains one bounded **scope lineage**.
The lineage is for consecutive read-only repetitions of that exact scope.
The lineage stores the admitted semantic scope (label/selector chain).
It does not store the old positional tree or mutation authority.
A repeated `snapshot -s @ref` may resolve through that lineage only when the immediately preceding frame publication was the same scoped capture.
Each of these events clears the lineage:

- The first device-side effect.
- An unrelated frame publication.
- Another scope.

An arbitrary stale or unissued scope ref still fails closed.
It cannot borrow lineage or authorize a different subtree.
Empty, sparse, failed, or unusable repeated captures preserve the last useful frame and its still-consecutive lineage.
Selector-scoped captures follow their normal selector rules.

These outputs are partial external publications:

- Snapshot diffs.
- Digests that omit the namespace.
- `find`.
- Settled diffs/tails.
- Replay divergence screens.

They activate a partial frame only when at least one ref and its epoch are visible to the caller or orchestrated workflow.
An empty partial result does not supersede useful existing authority.

Publication of a partial frame intentionally supersedes the prior frame.
This avoids retention of an unbounded set of generation-specific trees.
It also makes the limited authority of the partial frame explicit.
Only refs named in that partial response can be used for mutation, and only with their response-level epoch.

An explicit, non-diff complete snapshot leaf may activate a frame inside replay or batch before the outer orchestrator returns.
This is true even when the outer response level later elides or digests that tree.
This execution-local activation is a deliberate compatibility exception for deterministic `snapshot -> @ref` scripts.
It authorizes only predeclared later bare-ref steps.
It does not:

- Publish pins to the outer caller or MCP.
- Make the outer response ref-issuing.
- Add general result interpolation.

Internally injected, cached, freshness, and recovery captures never receive this exception.
A nested non-empty partial publication may supersede scope.
But batch and replay have no dynamic generation binding with which a later step could consume it.

### Mutation admission and read behavior

A ref-targeting mutation is admitted only when all of these conditions hold:

1. The frame is active.
2. A pinned ref carries the current epoch, or a plain ref is used against a complete `all` frame.
3. The ref body belongs to the issuance scope of the frame.
4. Normal target guards and replay target-binding verification pass.

The target is resolved against the authorized frame, never against a newer operational observation by positional coincidence.
Android freshness captures may verify current identity or provide comparison evidence.
But they must not redefine which node an already-admitted `@eN` authorizes.

Read-only ref consumers remain fail-open with a structured staleness warning only when the retained frame contains the evidence necessary to resolve that ref.
A stale read is observable and recoverable.
A stale mutation can act on the wrong element.
Missing frame evidence fails, instead of falling through to a newer operational observation by positional coincidence.
Reads never reactivate a frame or convert an unissued ref into mutation authority.

Rejected mutations use the existing error system.
Admission evaluates failures in this order, and each failure has a typed reason:

1. `ref_frame_expired`: a side effect invalidated the current frame.
2. `ref_generation_mismatch`: a pin names another epoch.
3. `plain_ref_requires_complete_frame`: a plain ref targets a partial frame.
4. `ref_not_issued`: a pinned ref is outside the issuance set of a partial frame.

With the typed reasons, callers can distinguish "capture a complete snapshot" from "use the emitted pinned ref".
Each failure includes `details.ref`, `details.reason`, `details.currentGeneration`, and the frame scope.
When the input is pinned, the failure also includes `details.mintedGeneration`.
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
When the actual failure is lifetime expiration, error messages must not claim that a found ref was missing or lacked bounds.

### Expiration occurs at the side-effect seam

Expiration occurs after these and all other pre-action guards pass:

- Syntax.
- Capability.
- Freshness.
- Target resolution.
- Replay identity.
- Occlusion.
- Visibility.
- Bounds.

Expiration occurs immediately before the first operation that may change device-visible element identity.
Before you await that operation, persist the in-memory transition.

Failure before this seam preserves the frame.
After the seam is crossed, success, timeout, cancellation, connection loss, and ambiguous platform errors all leave the frame expired, because the device may already have acted.
A crossing of the seam also clears scoped-snapshot lineage.
There is no success-only rollback.

This rule applies to every execution shape:

- Runtime ref/selector/coordinate paths expire before `tap`, `fill`, `longPress`, text input, or gesture execution.
- Native web ref paths run their existing ref preflight first, and then expire before `clickRef` or `fillRef`.
- Direct iOS selector paths consume no ref, but they expire any existing frame before the fused runner resolve-and-act request.
- Platform-generic, app lifecycle, keyboard, alert, settings, and provider actions expire at their actual leaf side-effect seam, not at generic request admission.
- `open`/relaunch against an existing session expires the frame of that session before the first close/launch dispatch.
  A failure or timeout after dispatch leaves the frame expired.
  A successful `close` deletes the session, and thus retains no frame to restore.
- After an error, a fallback or retry may proceed only when the error proves no prior side effect.
  Ambiguous post-dispatch errors neither restore the frame nor authorize an automatic second action.
- Android blocking-dialog recovery is itself device-mutating.
  Its recovery tap/relaunch must cross the same idempotent seam before it acts, even when apparent readiness work invokes the recovery.
  If recovery mutates before a requested ref action dispatches, that ref action aborts with `ref_frame_expired`.
  The ref action cannot continue against the recovered UI.
  Selector and coordinate actions may re-resolve and continue under their existing policies.

The seam is deliberately inside leaf execution.
Expiration at router entry would cause these problems:

- It would reject the ref that the current command needs.
- It would invalidate on ordinary validation failures.
- It would mishandle multiplexed and orchestrating commands.

Some platform operations fuse their final status/target check and their mutation in one request.
Examples are direct iOS selectors and current native alert or keyboard actions.
Until a lower-level "will act" callback exists, the dispatch of that fused request is the conservative seam.
A later `not found`, `already hidden`, timeout, or no-alert result is post-seam and does not restore the frame.
A command with a separate, definitive read-only status request preserves the frame when that status proves that no mutation request was dispatched.

### Command effects are daemon-owned and completely classified

The daemon facet of the command descriptor declares a request policy:

```ts
type RefFrameEffect = 'preserve' | 'may-invalidate' | 'delegated';

type DaemonRefFrameEffect = RefFrameEffect | ((request: DaemonRequest) => RefFrameEffect);
```

The daemon registry exposes a named resolver.
Every daemon command is classified.
But the classification is an honesty/completeness guard, not the transition site.
`may-invalidate` means that some successful path can cross a device side effect.
The leaf implementation still calls the ref-frame module only when that path is selected.
Request-sensitive commands use a focused resolver, instead of a pretense that all subcommands behave alike.

The registry is the exhaustive source of truth.
The table below is non-exhaustive guidance for the classification of representative actions.
The table must not become a second prose registry:

| Effect | Commands/actions |
| --- | --- |
| `may-invalidate` | press, click, fill, longpress, type, focus, scroll, swipe, gesture, back, home, `tv-remote`, orientation, open/relaunch, trigger/push delivery, settings changes, install/reinstall, React Native overlay dismissal, and lifecycle operations that can replace the visible surface |
| Conditional resolver | keyboard status preserves while dismiss/return/input invalidate; alert get/wait preserve while accept/dismiss invalidate; find reads preserve while click/fill/focus/type delegate to their leaf mutation |
| `delegated` | batch, replay, and test/suite orchestrators; each nested leaf owns its transition |
| `preserve` | snapshots and other observation, assertion, screenshot, recording, trace, logs, events, network inspection, performance, inventory, capability, lease, and transport-management operations unless a selected subaction directly manipulates the visible surface |

Clipboard reads and writes preserve the frame, because pasteboard state alone does not change element identity.
A later paste/type action is independently invalidating.

Generic routing is not an exception to the policy.
`back`, `home`, `orientation`, `scroll`, `tv-remote`, and `app-switcher` all reach the generic daemon leaf.
When they act, they must cross the same transition there.
The completeness gate covers every command projected to the daemon, including generic fallbacks.
Thus, a missing facet cannot hide an unclassified mutation.
Mutations that unrelated external tools perform remain outside this session guarantee.

This policy is not derived from the runner-side classification.
Apple runner command traits govern retry eligibility, launch policy, and the recorded-failure conversion at a lower wire-command seam.
The TypeScript `readOnly` trait is itself an input to several daemon decisions:

- Read-only resend.
- Session-invalidation skip.
- Transport error classification.
- Readiness preflight.

`refFrameEffect` governs daemon session authorization, and it includes commands that never reach the Apple runner.
Narrow consistency tests may cover direct mappings.
But blanket parity would couple different concepts.

The existing per-session request lock serializes frame admission and transitions.
The frame is shared session state, not per-client or per-lease history.
Generation pins make the rejected epoch and reason precise.
They do not reserve a frame, and they do not prevent the mutation of another caller from expiring it.
No second ref-specific mutex is introduced.

### Batch, replay, recording, and repeated actions

Batch and replay invoke their steps sequentially through ordinary daemon dispatch, and they are `delegated`.
They never expire a frame merely because the outer command began.
Frame state naturally carries between leaf steps:

- `snapshot -> press @e1 -> press @e2` executes the first press and rejects the second.
- `snapshot -> press @e1 -> press @e1 -> press @e2` also stops on the second press, before `@e2`.
- `snapshot -> press @e1 -> snapshot -> press @e2` is admitted.
- Selector-only and coordinate-only batches retain their request-round-trip advantage.
- A stale-ref failure stops batch through its existing policy.
  The failure preserves `step`, `command`, `executed`, `total`, `partialResults`, diagnostic fields, and `details.reason`.

Batch does not gain any of these:

- Nested MCP pin traversal.
- Intermediate-result interpolation.
- An unsafe "assume stable refs" override.
- A second static lifecycle interpreter.

Normal leaf dispatch is the single enforcement path.

Recorded `.ad` scripts remain selector-first.
The recorder continues to convert successfully resolved refs to selector chains.
It refuses to persist an unresolved session-bound bare ref.
Generation suffixes remain runtime evidence.
They are stripped from durable recordings, because seeded epochs are not portable across sessions.
Legacy hand-written `.ad` scripts that mutate through several bare refs from one snapshot become intentionally incompatible.
These scripts must capture between mutations or use selectors.
Replay target-binding verification completes before the side-effect seam.
Identity divergence preserves the frame, while an action failure after dispatch leaves it expired.

Each of these is one logical command:

- `press --count`.
- Double-tap.
- Hold.
- Jitter.
- `swipe --count`.
- Platform sequence chunks.

Each one resolves or plans once, expires once before the first repetition, and executes the original physical point/plan for every repetition.
It does not re-resolve the target or reactivate the frame between repetitions.
Failure in any later repetition or chunk leaves the frame expired.
This preserves the explicit repeated-physical-interaction contract, and it prevents later commands from reuse of the frame.

### Partial issuance and MCP

`find`, settled diffs/tails, and replay divergence screens publish only the refs that they actually return.
They must not call a whole-frame "refs issued" marker.

Read-only `find` may partially publish its returned ref.
A mutating `find` returns the acted ref only as diagnostic pre-action identity:

- It must omit `refsGeneration`.
- It must not publish or activate a frame.
- It cannot make that ref valid after the nested action.

The MCP executor continues to store per-ref pins by state-directory/session scope.
Issuance handling must distinguish the selected `find` action.
It must not infer issuance from the command name alone.
A read-only `find` with `refsGeneration` merges its partial pin.
A mutating `find` without `refsGeneration` is explicitly non-issuing, and it leaves every remembered pin unchanged.
It must not enter a generic missing-generation branch that clears the pin scope of the session.
The executor must carry sufficient normalized command/action context to make that distinction.
Remembered pins are not cleared on mutation.
The daemon produces a precise stale rejection from the remembered old epoch that the executor sends.
MCP currently does not traverse refs nested inside batch inputs, and it does not learn refs from nested batch results.
This remains an explicit non-goal.

The response-level `refsGeneration` field remains the token-economical authority.
Snapshot nodes never gain per-node generation bytes.
Every reusable ref in a partial CLI text result must render in the ready-to-copy `@eN~s<refsGeneration>` form.
JSON and Node.js responses retain plain ref bodies plus one response-level generation.
Before a mutation, callers must pair them.
MCP may render a plain ref, because it stores and forwards the pin internally.
Complete snapshot trees remain plain to protect the token budget.
A mutating `find` diagnostic ref is never rendered or stored as pinned, because it carries no `refsGeneration`.

## Performance and compatibility

Expiration is O(1): one monotonic epoch transition and bounded in-memory state.
It adds no capture, platform request, daemon round trip, or per-node output.
The model retains at most one authorized frame and one latest operational observation.
These share immutable capture objects, not deep copies.
The model never caches an unbounded history of full trees.
Existing capture size limits remain the bound.
Memory pressure must not silently expire or swap a frame, because that would make deterministic admission depend on the environment.

The real cost is at the workflow level, and it is intentional.
A ref-oriented sequence that performs several mutations may need an explicit observation between them.
Callers can avoid unnecessary captures with:

- Selectors.
- Direct selector fast paths.
- A settled partial result whose emitted ref is pinned.
- `--count` for a repeated physical action at one resolved target.

The daemon never captures automatically for the sole purpose of a ref renewal.

Older clients remain wire-parse-compatible:

- Command grammar, `refsGeneration`, and `~s<n>` remain unchanged.
- Structured error details are additive.

Thus, ADR 0006 requires no protocol bump.
But older clients are not fully compatible in behavior:

- Unsafe plain-ref mutation chains newly fail.
- A fused command can also expire the frame when its eventual result is a no-op.
  Examples are `keyboard dismiss` that reports an already hidden keyboard, and an alert action that reports no alert.
- Read-only refs that lack retained frame evidence newly fail, instead of a warning and a resolution by positional coincidence against a newer observation.

These changes require CLI/help, changelog, `.ad` migration, and batch guidance.

This decision composes with existing ADRs as follows:

- ADR 0008: daemon-owned effect policy is composed in the descriptor daemon facet and projected only through the daemon registry.
- ADR 0004: capture plans and sparse-quality rules are unchanged, and no capture is added.
- ADR 0005: runner liveness/preflight state remains independent from session ref authorization.
- ADR 0006/0010: there is no RPC bump; typed `details.reason` and actionable hints follow the error contract.
- ADR 0007: the frame is session-scoped under the existing session/request lock, not client-local or lease-local.
- ADR 0009: one target model applies to Apple, Android, Linux, and web, while public platform output remains projected.
- ADR 0011: lifetime is a sibling session-sequence invariant, not another path-by-element-guarantee cell.
  Every mutating path still crosses the shared seam.
- ADR 0012: durable target identity remains selector/evidence based, and divergence refs become honest partial issuance.
- ADR 0013: coordinate gestures expire frames but remain outside the element guarantee matrix.

## Consequences

- A stale ref cannot silently mutate a different element after navigation.
  The caller receives a typed failure and must choose a fresh observation or a selector.
- Ref-oriented workflows that perform multiple logical mutations must capture again between the mutations, consume an honestly issued settled ref, use selectors, or use one repeated-action command such as `--count`.
  Legacy hand-written `.ad` scripts that reuse several bare refs from one snapshot must change.
- Conservative fused requests may consume ref authority even when the platform later reports that no action was necessary.
  This favors the avoidance of a wrong-screen action over the preservation of refs after an ambiguous dispatch.
- A read without retained evidence fails, instead of resolving the same positional ref body in a newer tree.
  Reads with retained evidence keep the structured warning behavior.
- Consecutive repeated scoped snapshots retain their admitted semantic scope.
  Any mutation, unrelated publication, or different scope breaks that lineage.
- The implementation pays for bounded bookkeeping in session memory.
  But it adds no automatic capture, platform call, round trip, or per-node response bytes.

## Required evidence

The implementation is not complete until contract and provider tests prove all of these:

1. After an unobserved first mutation, a bare and a pinned second mutation reject.
2. Definitive pre-seam validation, target, and replay-identity failures preserve the frame.
3. Timeout, cancellation, connection loss, and other post-seam failures leave the frame expired.
4. These paths cross the same seam: runtime ref/selector/coordinate, native ref, direct selector, provider-backed interaction, and provider-backed lifecycle/generic paths.
5. Android freshness cannot retarget an admitted ref through positional coincidence.
6. Read-only operational captures do not replace the authorized frame.
7. Partial publication admits only emitted pinned refs, reports each typed admission failure, and cannot bless unrelated plain refs.
   CLI text renders every reusable partial ref with its pin, while JSON and Node.js retain the response-level representation.
8. Complete publication admits its plain namespace, while sparse/unusable captures do not.
9. Mutating `find` omits `refsGeneration` and never pins or activates its pre-action ref as current post-action state.
   An MCP sequence that first remembers a snapshot pin and then performs mutating `find` still forwards the remembered old pin on a later ref input.
   Thus, the daemon rejects that pin as stale.
10. Batch and replay delegate per step and retain their existing failure/partial-result contracts.
    They allow `snapshot -> @ref` with an intermediate digest, without exposed pins or dynamic bindings.
11. Recorded scripts contain selectors, not portable generation claims.
12. Press/swipe series and Apple chunks resolve and expire exactly once.
13. Android dialog recovery expires before its first recovery side effect.
    After recovery mutates, the recovery aborts an outstanding ref action.
14. Consecutive repeated `snapshot -s @ref` calls resolve the same admitted semantic scope after scoped output reindexes refs.
    A mutation, an unrelated publication, or a different scope breaks the lineage.
    An arbitrary stale ref cannot use the lineage.
    Empty/unusable repetition preserves the last useful frame and the still-consecutive lineage.
15. Fused keyboard/alert requests and split status/action paths follow their documented conservative seams, including already-hidden and no-alert outcomes.
16. A failed or timed-out existing-session open/relaunch leaves the old frame expired after dispatch.
17. A read-only ref with retained stale evidence returns the structured warning.
    Missing frame evidence fails, without a fall-through to a newer observation by positional coincidence.
18. A large-tree fixture proves that frame/observation separation introduces no deep copy.
    The fixture records the bounded peak of retained nodes/bytes.
19. Enforcement and error shapes are consistent across supported platforms.

Performance regression tests prove that admission, expiration, and frame/observation separation add no implicit capture or provider/platform call.
Device benchmarks are required only if those tests or live evidence reveal a regression.
No path may claim success until a test proves that the relevant direct/native/runtime/provider branch actually executed.

Before enforcement is enabled for a platform, fresh-build live evidence must exercise every supported production seam affected on that platform:

- Apple runtime-ref and direct/native paths, where available.
- Android helper freshness and recovery.
- Generic/lifecycle mutation.
- At least one real provider-backed interaction plus lifecycle operation.

Each run must prove all of these:

1. A fresh ref succeeds.
2. A second mutation with the stale ref is rejected before dispatch.
3. A fresh observation restores usability.

A seam that is not exercised remains disabled or is recorded as an explicit release blocker.
Fixture-backed tests and registry claims are necessary, but they do not substitute for this live evidence.

## Alternatives considered

- **Stable refs across trees.** Rejected because positional accessibility snapshots have no durable cross-tree identity.
  Semantic IDs are neither universal nor unique.
- **Expire only after successful mutation.** Rejected because a timeout or transport failure may occur after the device acted.
- **Keep one snapshot for observation and authorization.** Rejected because read-only internal captures can reindex or invalidate caller refs.
- **Automatically capture after every mutation.** Rejected because it adds the dominant platform cost, and it can itself fail or be sparse.
  It also hides lifetime, instead of defining it.
- **Retain every generation's full tree.** Rejected because it uses unbounded session memory.
  It is also unnecessary for a single-current-frame contract.
- **Add a per-ref historical ledger immediately.** Rejected until evidence requires concurrent generation support.
  One bounded current frame plus issuance scope is sufficient.
- **Derive the policy from the runner's command traits.** Rejected because those traits classify a wire command for what the runner may still do about its app.
  Daemon ref authorization classifies a command for what the command did to the frame.
- **Add batch interpolation or an unsafe ref-stability override.** Rejected as a new orchestration interface that bypasses the same safety rule.
- **Force lifetime into ADR 0011's element path matrix.** Rejected because ref lifetime spans commands, time, non-element invalidators, and orchestrators.
  The matrix remains the enforcement record for per-path element guarantees.
