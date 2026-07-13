# ADR 0014: Session Ref-Frame Lifetime

## Status

Proposed

## Context

Snapshot refs such as `@e12` are positional names inside one accessibility-tree namespace. They are
cheap and effective within that namespace, but they do not identify an element across navigation,
layout changes, or another capture whose positional ordering differs. A generation pin such as
`@e12~s42` identifies the namespace that issued the ref; it does not make the element stable.

The current session model conflates two different concepts in `session.snapshot`:

1. the latest operational observation used by selector matching, verification, settling, Android
   freshness, overlays, and diagnostics; and
2. the caller-authorized tree whose refs may be used for a later mutation.

That conflation creates failures in both directions. A mutation can change the device without
capturing another tree, leaving the old positional refs apparently current. Conversely, an internal
read-only capture can replace `session.snapshot` and invalidate refs even though the caller performed
no mutation. Partial outputs such as `find`, settled diffs, and replay divergence screens can then
clear the coarse stale marker for the whole replacement tree even though they exposed only a few
refs.

Issue [#1239](https://github.com/callstack/agent-device/issues/1239) and PR
[#1241](https://github.com/callstack/agent-device/pull/1241) demonstrate the first failure on iOS:
`snapshot -> press @e1 -> press @e2` can dispatch both presses when the first press performs no
internal capture. The second ref is resolved against pre-action coordinates even if the first press
navigated. A false successful tap on the new screen is worse than a clear stale-ref failure.

The lifetime contract must be consistent across platforms and dispatch paths, preserve fast paths,
remain compatible with selector-based replay, and add no automatic capture or per-node output bytes.

## Decision

The terms introduced below describe the proposed target model. They do not replace the current domain
language in `CONTEXT.md` while this ADR is Proposed and the source still implements the snapshot/stale
marker model. The implementation change that establishes these concepts must promote the accepted
terms into `CONTEXT.md`; documentation must not present the target model as current behavior early.

### Ref frames are separate from operational observations

A session owns at most one **ref frame**. The frame is the authorization namespace for mutation refs
and contains:

- a seeded, monotonic **ref-frame epoch**, exposed through the existing `refsGeneration` field and
  accepted through the existing `~s<n>` input suffix;
- the immutable source tree needed to resolve and guard the refs it issued;
- a state of `active` or `expired`; and
- an issuance scope of `all` or a bounded set of issued ref bodies.

Operational captures update the latest observation used by selector and diagnostic machinery. They
do not silently replace, reactivate, or reindex the authorized ref frame. The implementation may
share immutable tree objects between the observation and frame, but it must not make their lifetimes
the same by aliasing mutable session state.

Only one frame is retained. Activating a new frame supersedes the previous frame and advances the
epoch; historical generation-to-tree caches are not introduced. Complete and partial frames retain
the immutable source tree because interaction guards and replay identity can depend on context outside
the emitted subset, including ancestors, siblings, overlays, and the viewport. The issuance set, not
the evidence tree, bounds partial authority. The frame and latest observation share immutable capture
data when they originate from the same capture; neither transition deep-copies the tree.

The existing `snapshotGeneration`/`snapshotRefsStale` implementation evolves behind one ref-frame
module. The public name `refsGeneration` and the `@e12~s42` grammar remain unchanged for wire
compatibility.

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

A complete activation normally accompanies a command result that exposes the complete ref namespace
for the stored frame, including an interactive or intentionally scoped snapshot. An intentionally
scoped snapshot replaces authorization with exactly its returned namespace; it neither authorizes
matching ref bodies outside that scope nor retains the old `all` scope.

A frame-activating capture scoped by `@ref` must first admit that scope ref against the current active
frame. To preserve the existing repeated scoped-snapshot contract after scoped output reindexes refs,
the session retains one bounded **scope lineage** for consecutive read-only repetitions of that exact
scope. The lineage stores the admitted semantic scope (label/selector chain), not the old positional
tree or mutation authority. A repeated `snapshot -s @ref` may resolve through that lineage only when
the immediately preceding frame publication was the same scoped capture. The first device-side effect,
an unrelated frame publication, or another scope clears the lineage. An arbitrary stale or unissued
scope ref still fails closed; it cannot borrow lineage or authorize a different subtree. Empty, sparse,
failed, or unusable repeated captures preserve the last useful frame and its still-consecutive lineage.
Selector-scoped captures follow their normal selector rules.

Snapshot diffs, digests that omit the namespace, `find`, settled diffs/tails, and replay divergence
screens are partial external publications. They activate a partial frame only when at least one ref
and its epoch are visible to the caller or orchestrated workflow. An empty partial result does not
supersede useful existing authority.

Publishing a partial frame intentionally supersedes the prior frame. This avoids retaining an
unbounded set of generation-specific trees and makes its limited authority explicit: only refs named
in that partial response can be used for mutation, and only with their response-level epoch.

An explicit, non-diff complete snapshot leaf may activate a frame inside replay or batch before the
outer orchestrator returns, even when the outer response level later elides or digests that tree. This
execution-local activation is a deliberate compatibility exception for deterministic
`snapshot -> @ref` scripts. It authorizes only predeclared later bare-ref steps; it does not publish
pins to the outer caller or MCP, make the outer response ref-issuing, or add general result
interpolation. Internally injected, cached, freshness, and recovery captures never receive this
exception. A nested non-empty partial publication may supersede scope, but batch and replay have no
dynamic generation binding with which a later step could consume it.

### Mutation admission and read behavior

A ref-targeting mutation is admitted only when all of the following hold:

1. the frame is active;
2. a pinned ref carries the current epoch, or a plain ref is used against a complete `all` frame;
3. the ref body belongs to the frame's issuance scope; and
4. normal target guards and replay target-binding verification pass.

The target is resolved against the authorized frame, never against a newer operational observation
by positional coincidence. Android freshness captures may verify current identity or provide
comparison evidence, but they must not redefine which node an already-admitted `@eN` authorizes.

Read-only ref consumers remain fail-open with a structured staleness warning only when the retained
frame contains the evidence needed to resolve that ref. A stale read is observable and recoverable;
a stale mutation can act on the wrong element. Missing frame evidence fails rather than falling
through to a newer operational observation by positional coincidence. Reads never reactivate a frame
or convert an unissued ref into mutation authority.

Rejected mutations use the existing error system. Admission failures are evaluated in the order
below and have typed reasons so callers can distinguish "capture a complete snapshot" from "use the
emitted pinned ref":

- `ref_frame_expired` when a side effect invalidated the current frame;
- `ref_generation_mismatch` when a pin names another epoch;
- `plain_ref_requires_complete_frame` when a plain ref targets a partial frame; and
- `ref_not_issued` when a pinned ref is outside a partial frame's issuance set.

Each failure includes `details.ref`, `details.reason`, `details.currentGeneration`, the frame scope,
and `details.mintedGeneration` when the input is pinned. For example:

```text
code: COMMAND_FAILED
message: Ref @e12 belongs to an expired ref frame
details.reason: ref_frame_expired
details.ref: @e12
details.currentGeneration: 43
details.mintedGeneration: 42  # present only when the input was pinned
hint: Capture a fresh interactive snapshot or use a stable selector.
```

The daemon cannot truthfully report `mintedGeneration` for a plain ref. Error messages must not claim
that a found ref was missing or lacked bounds when the actual failure is lifetime expiration.

### Expiration occurs at the side-effect seam

Expiration occurs after syntax, capability, freshness, target resolution, replay identity,
occlusion, visibility, bounds, and other pre-action guards pass, but immediately before the first
operation that may change device-visible element identity. Persist the in-memory transition before
awaiting that operation.

Failure before this seam preserves the frame. Once the seam is crossed, success, timeout,
cancellation, connection loss, and ambiguous platform errors all leave it expired because the device
may already have acted. Crossing the seam also clears scoped-snapshot lineage. There is no success-only
rollback.

This rule applies to every execution shape:

- runtime ref/selector/coordinate paths expire before `tap`, `fill`, `longPress`, text input, or
  gesture execution;
- native web ref paths run their existing ref preflight first, then expire before `clickRef` or
  `fillRef`;
- direct iOS selector paths consume no ref but expire any existing frame before the fused runner
  resolve-and-act request;
- platform-generic, app lifecycle, keyboard, alert, settings, and provider actions expire at their
  actual leaf side-effect seam, not at generic request admission;
- `open`/relaunch against an existing session expires that session's frame before the first
  close/launch dispatch. A failure or timeout after dispatch leaves it expired; a successful `close`
  deletes the session and therefore retains no frame to restore;
- a fallback or retry may proceed after an error only when the error proves no prior side effect;
  ambiguous post-dispatch errors neither restore the frame nor authorize an automatic second action;
- Android blocking-dialog recovery is itself device-mutating. Its recovery tap/relaunch must cross
  the same idempotent seam before acting, even when invoked from apparent readiness work. If recovery
  mutates before a requested ref action dispatches, that ref action aborts with
  `ref_frame_expired`; it cannot continue against the recovered UI. Selector and coordinate actions
  may re-resolve and continue under their existing policies; and
- automatic no-change retries assert that the originating action already expired the frame before
  any retry coordinate is sent.

The seam is deliberately inside leaf execution. Expiring at router entry would reject the ref needed
by the current command, invalidate on ordinary validation failures, and mishandle multiplexed and
orchestrating commands.

Some platform operations fuse their final status/target check and mutation in one request, including
direct iOS selectors and current native alert or keyboard actions. Until a lower-level "will act"
callback exists, dispatching that fused request is the conservative seam. A later `not found`,
`already hidden`, timeout, or no-alert result is post-seam and does not restore the frame. A command
with a separate definitive read-only status request preserves the frame when that status proves no
mutation request was dispatched.

### Command effects are daemon-owned and completely classified

The command descriptor's daemon facet declares a request policy:

```ts
type RefFrameEffect = 'preserve' | 'may-invalidate' | 'delegated';

type DaemonRefFrameEffect =
  | RefFrameEffect
  | ((request: DaemonRequest) => RefFrameEffect);
```

The daemon registry exposes a named resolver. Every daemon command is classified, but the
classification is an honesty/completeness guard rather than the transition site. `may-invalidate`
means that some successful path can cross a device side effect; the leaf implementation still calls
the ref-frame module only when that path is selected. Request-sensitive commands use a focused
resolver rather than pretending all subcommands behave alike.

The registry is the exhaustive source of truth. The following table is non-exhaustive guidance for
classifying representative actions; it must not become a second prose registry:

| Effect | Commands/actions |
| --- | --- |
| `may-invalidate` | press, click, fill, longpress, type, focus, scroll, swipe, gesture, back, home, `tv-remote`, rotate, open/relaunch, trigger/push delivery, settings changes, install/reinstall, React Native overlay dismissal, and lifecycle operations that can replace the visible surface |
| Conditional resolver | keyboard status preserves while dismiss/return/input invalidate; alert get/wait preserve while accept/dismiss invalidate; find reads preserve while click/fill/focus/type delegate to their leaf mutation |
| `delegated` | batch, replay, and test/suite orchestrators; each nested leaf owns its transition |
| `preserve` | snapshots and other observation, assertion, screenshot, recording, trace, logs, events, network inspection, performance, inventory, capability, lease, and transport-management operations unless a selected subaction directly manipulates the visible surface |

Clipboard reads and writes preserve the frame because pasteboard state alone does not change element
identity. A later paste/type action is independently invalidating.

Generic routing is not an exception to the policy. `back`, `home`, `rotate`, `scroll`, `tv-remote`,
and `app-switcher` all reach the generic daemon leaf and must cross the same transition there when
they act. `app-switcher` is currently projected to the daemon by a direct writer but, unlike its
generic-routed siblings, omits an explicit daemon descriptor facet and relies on the registry's
generic fallback. Migration adds that facet and its effect classification; it does not invent a
specialized route. The completeness gate covers every command projected to the daemon, including
generic fallbacks, so a missing facet cannot hide an unclassified mutation. Mutations performed by
unrelated external tools remain outside this session guarantee.

This policy is not derived from Apple runner `readOnly`. Runner traits govern retry, liveness,
readiness probes, and preflight skipping at a lower wire-command seam. `refFrameEffect` governs
daemon session authorization and includes commands that never reach the Apple runner. Narrow
consistency tests may cover direct mappings, but blanket parity would couple different concepts.

Frame admission and transitions are serialized by the existing per-session request lock. The frame
is shared session state, not per-client or per-lease history. Generation pins make the rejected epoch
and reason precise; they do not reserve a frame or prevent another caller's mutation from expiring it.
No second ref-specific mutex is introduced.

### Batch, replay, recording, and repeated actions

Batch and replay invoke their steps sequentially through ordinary daemon dispatch and are
`delegated`. They never expire a frame merely because the outer command began. Frame state naturally
carries between leaf steps:

- `snapshot -> press @e1 -> press @e2` executes the first press and rejects the second;
- `snapshot -> press @e1 -> press @e1 -> press @e2` also stops on the second press, before `@e2`;
- `snapshot -> press @e1 -> snapshot -> press @e2` is admitted;
- selector-only and coordinate-only batches retain their request-round-trip advantage; and
- a stale-ref failure stops batch through its existing policy and preserves `step`, `command`,
  `executed`, `total`, `partialResults`, diagnostic fields, and `details.reason`.

Batch does not gain nested MCP pin traversal, intermediate-result interpolation, an unsafe
"assume stable refs" override, or a second static lifecycle interpreter. Normal leaf dispatch is the
single enforcement path.

Recorded `.ad` scripts remain selector-first. The recorder continues converting successfully
resolved refs to selector chains and refuses to persist an unresolved session-bound bare ref.
Generation suffixes remain runtime evidence and are stripped from durable recordings because seeded
epochs are not portable across sessions. Legacy hand-written `.ad` scripts that mutate through
several bare refs from one snapshot become intentionally incompatible; they must capture between
mutations or use selectors. Replay target-binding verification completes before the side-effect seam;
identity divergence preserves the frame, while an action failure after dispatch leaves it expired.

`press --count`, double-tap, hold, jitter, `swipe --count`, and platform sequence chunks are one
logical command. They resolve or plan once, expire once before the first repetition, and execute the
original physical point/plan for every repetition. They do not re-resolve the target or reactivate the
frame between repetitions. Failure in any later repetition or chunk leaves the frame expired. This
preserves the explicit repeated-physical-interaction contract while preventing later commands from
reusing the frame.

### Partial issuance and MCP

`find`, settled diffs/tails, and replay divergence screens publish only the refs they actually return.
They must not call a whole-frame "refs issued" marker.

Read-only `find` may partially publish its returned ref. A mutating `find` returns the acted ref only
as diagnostic pre-action identity: it must omit `refsGeneration`, must not publish or activate a
frame, and cannot make that ref valid after the nested action.

The MCP executor continues storing per-ref pins by state-directory/session scope. Issuance handling
must distinguish the selected `find` action, not infer issuance from the command name alone. A
read-only `find` with `refsGeneration` merges its partial pin. A mutating `find` without
`refsGeneration` is explicitly non-issuing and leaves every remembered pin unchanged; it must not
enter a generic missing-generation branch that clears the session's pin scope. The executor must carry
enough normalized command/action context to make that distinction. Remembered pins are not cleared on
mutation: sending the remembered old epoch is how the daemon produces a precise stale rejection. MCP
currently neither traverses refs nested inside batch inputs nor learns refs from nested batch results;
this remains an explicit non-goal.

The response-level `refsGeneration` field remains the token-economical authority. Snapshot nodes never
gain per-node generation bytes. Every reusable ref in a partial CLI text result must render in
ready-to-copy `@eN~s<refsGeneration>` form. JSON and Node.js responses retain plain ref bodies plus one
response-level generation; callers must pair them before a mutation. MCP may render a plain ref because
it stores and forwards the pin internally. Complete snapshot trees remain plain to protect the token
budget. A mutating `find` diagnostic ref is never rendered or stored as pinned because it carries no
`refsGeneration`.

## Performance and compatibility

Expiration is O(1): one monotonic epoch transition and bounded in-memory state. It adds no capture,
platform request, daemon round trip, or per-node output. The model retains at most one authorized frame
and one latest operational observation, sharing immutable capture objects rather than deep copies; it
never caches an unbounded history of full trees. Existing capture size limits remain the bound. Memory
pressure must not silently expire or swap a frame because that would turn deterministic admission into
environment-dependent behavior.

The real cost is workflow-level and intentional. A ref-oriented sequence that performs several
mutations may need an explicit observation between them. Callers can avoid unnecessary captures by
using selectors, direct selector fast paths, a settled partial result whose emitted ref is pinned, or
`--count` for a repeated physical action at one resolved target. The daemon never auto-captures merely
to renew refs.

Older clients remain wire-parse-compatible: command grammar, `refsGeneration`, and `~s<n>` remain
unchanged, and structured error details are additive, so ADR 0006 requires no protocol bump. They are
not fully behaviorally compatible. Unsafe plain-ref mutation chains newly fail. A fused command can
also expire the frame when its eventual result is a no-op, such as `keyboard dismiss` reporting that
the keyboard was already hidden or an alert action reporting no alert. Read-only refs that lack
retained frame evidence newly fail instead of warning and resolving by positional coincidence against
a newer observation. These changes require CLI/help, changelog, `.ad` migration, and batch guidance.

It composes with existing ADRs as follows:

- ADR 0003/0008: daemon-owned effect policy is composed in the descriptor daemon facet and projected
  only through the daemon registry;
- ADR 0004: capture plans and sparse-quality rules are unchanged, and no capture is added;
- ADR 0005: runner liveness/preflight state remains independent from session ref authorization;
- ADR 0006/0010: no RPC bump; typed `details.reason` and actionable hints follow the error contract;
- ADR 0007: the frame is session-scoped under the existing session/request lock, not client- or
  lease-local;
- ADR 0009: one target model applies to Apple, Android, Linux, and web while public platform output
  remains projected;
- ADR 0011: lifetime is a sibling session-sequence invariant, not another path-by-element-guarantee
  cell; every mutating path still crosses the shared seam;
- ADR 0012: durable target identity remains selector/evidence based, and divergence refs become
  honest partial issuance; and
- ADR 0013: coordinate gestures expire frames but remain outside the element guarantee matrix.

## Consequences

- A stale ref cannot silently mutate a different element after navigation; the caller receives a
  typed failure and must choose a fresh observation or a selector.
- Ref-oriented workflows that perform multiple logical mutations must capture again between them,
  consume an honestly issued settled ref, use selectors, or use one repeated-action command such as
  `--count`. Legacy hand-written `.ad` scripts that reuse several bare refs from one snapshot must
  change.
- Conservative fused requests may consume ref authority even when the platform later reports that no
  action was needed. This favors avoiding a wrong-screen action over preserving refs after an
  ambiguous dispatch.
- A read without retained evidence fails rather than resolving the same positional ref body in a
  newer tree. Reads with retained evidence keep the structured warning behavior.
- Consecutive repeated scoped snapshots retain their admitted semantic scope, while any mutation,
  unrelated publication, or different scope breaks that lineage.
- The implementation pays bounded session-memory bookkeeping but adds no automatic capture, platform
  call, round trip, or per-node response bytes.

## Required evidence

The implementation is not complete until contract and provider tests prove:

1. a bare and pinned second mutation reject after an unobserved first mutation;
2. definitive pre-seam validation, target, and replay-identity failures preserve the frame;
3. timeout, cancellation, connection loss, and other post-seam failures leave it expired;
4. runtime ref/selector/coordinate, native ref, direct selector, provider-backed interaction, and
   provider-backed lifecycle/generic paths cross the same seam;
5. Android freshness cannot retarget an admitted ref through positional coincidence;
6. read-only operational captures do not replace the authorized frame;
7. partial publication admits only emitted pinned refs, reports each typed admission failure, cannot
   bless unrelated plain refs, and CLI text renders every reusable partial ref with its pin while JSON
   and Node.js retain the response-level representation;
8. complete publication admits its plain namespace while sparse/unusable captures do not;
9. mutating `find` omits `refsGeneration` and never pins or activates its pre-action ref as current
   post-action state; an MCP sequence that first remembers a snapshot pin, then performs mutating
   `find`, still forwards the remembered old pin on a later ref input so the daemon rejects it as stale;
10. batch and replay delegate per step, retain their existing failure/partial-result contracts, and
    allow `snapshot -> @ref` with an intermediate digest without exposing pins or dynamic bindings;
11. recorded scripts contain selectors rather than portable generation claims;
12. press/swipe series and Apple chunks resolve and expire exactly once;
13. Android dialog recovery expires before its first recovery side effect and aborts an outstanding
    ref action after recovery mutates;
14. consecutive repeated `snapshot -s @ref` calls resolve the same admitted semantic scope after
    scoped output reindexes refs; a mutation, unrelated publication, or different scope breaks the
    lineage; an arbitrary stale ref cannot use it; and empty/unusable repetition preserves the last
    useful frame and still-consecutive lineage;
15. fused keyboard/alert requests and split status/action paths follow their documented conservative
    seams, including already-hidden and no-alert outcomes;
16. failed or timed-out existing-session open/relaunch leaves the old frame expired after dispatch;
17. a read-only ref with retained stale evidence returns the structured warning, while missing frame
    evidence fails without falling through to a newer observation by positional coincidence;
18. a large-tree fixture proves frame/observation separation introduces no deep copy and records the
    bounded peak retained nodes/bytes; and
19. enforcement and error shapes are consistent across supported platforms.

Performance regression tests prove that admission, expiration, and frame/observation separation add
no implicit capture or provider/platform call. Device benchmarks are required only if those tests or
live evidence reveal a regression. No path may claim success until a test proves the relevant
direct/native/runtime/provider branch actually executed.

Before enforcement is enabled for a platform, fresh-build live evidence must exercise every supported
production seam affected there: Apple runtime-ref and direct/native paths where available, Android
helper freshness and recovery, generic/lifecycle mutation, and at least one real provider-backed
interaction plus lifecycle operation. Each run must prove a fresh ref succeeds, a second mutation with
the stale ref is rejected before dispatch, and a fresh observation restores usability. A seam not
exercised remains disabled or is recorded as an explicit release blocker. Fixture-backed tests and
registry claims are necessary but do not substitute for this live evidence.

## Migration

Each step lands green and independently useful:

1. introduce the bounded ref-frame module and separate operational observations without changing
   enforcement;
2. add the complete daemon descriptor classification and gate, including request-sensitive resolvers;
3. route every leaf side effect, fallback, retry, and readiness recovery through the idempotent
   pre-side-effect transition;
4. correct complete/partial publication, bounded scoped-snapshot lineage, MCP pin retention, pinned
   partial CLI text, and JSON/Node.js response-level generation handling;
5. decouple Android freshness capture from positional ref authorization;
6. add sequence, batch, replay, series, failure-boundary, and cross-platform provider contracts;
7. enable fail-closed mutation enforcement per platform only after its paths have evidence, ending in
   one uniform policy; and
8. update help, changelog, ADR 0012's proposed-amendment note and tests, and replay/batch guidance for
   refresh-between-mutations, conservative fused no-op invalidation, and reads without retained
   evidence; promote the implemented vocabulary into `CONTEXT.md`; then remove the superseded coarse
   stale marker.

PR #1241 landed independently as a compatible transitional fix. It rejects a known iOS stale-marker
case before this full lifecycle is implemented; it does not own the architecture migration.

## Alternatives considered

- **Stable refs across trees:** rejected because positional accessibility snapshots have no durable
  cross-tree identity, and semantic IDs are neither universal nor unique.
- **Expire only after successful mutation:** rejected because a timeout or transport failure may occur
  after the device acted.
- **Keep one snapshot for observation and authorization:** rejected because read-only internal captures
  can reindex or invalidate caller refs.
- **Automatically capture after every mutation:** rejected because it adds the dominant platform cost,
  can itself fail or be sparse, and hides rather than defines lifetime.
- **Retain every generation's full tree:** rejected as unbounded session memory and unnecessary for a
  single-current-frame contract.
- **Add a per-ref historical ledger immediately:** rejected until evidence requires concurrent
  generation support; one bounded current frame plus issuance scope is sufficient.
- **Derive the policy from runner read-only traits:** rejected because runner liveness and daemon ref
  authorization classify different commands for different reasons.
- **Add batch interpolation or an unsafe ref-stability override:** rejected as a new orchestration
  interface that bypasses the same safety rule.
- **Force lifetime into ADR 0011's element path matrix:** rejected because ref lifetime spans commands,
  time, non-element invalidators, and orchestrators; the matrix remains the enforcement record for
  per-path element guarantees.
