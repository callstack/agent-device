# ADR 0011: Interaction Guarantee Contract (path × guarantee matrix)

## Status

Accepted (implemented through Layer 3, 2026-07-04: #1080, #1082–#1086, #1091, #1092; ambiguity contract amended 2026-08-07)

Completed process history is in git history.

## Rules at a glance

- Classify every dispatch-path × guarantee cell in the typed registry.
- Link each `gap:` waiver to a tracking issue. Keep command-scoped claims within the commands that the path dispatches.
- Give each guarantee exactly one TypeScript home that all TypeScript paths import. Prove the parity of runner-side Swift twins through golden fixture tables.
- Prove every non-waived cell through a tagged contract scenario.
- Delegation-on-error does not prove success-path parity.
- On the native-ref path, before `tapTarget`/`fillTarget`, check offscreen, occlusion, and non-hittable against the node from the daemon snapshot.
- The Apple runner does not resend a mutating command whose first send may have run.
- Multiple mutating selector matches collapse only if they form one ancestor–descendant chain and every member resolves to the same actionable node. Otherwise, the mutation fails with `AMBIGUOUS_MATCH`. Maestro's explicit expected-point/non-hittable compatibility path stays separate.
- Keep synthesized iOS gesture policy outside the element dispatch-path matrix.

## Context

Interaction commands reach the device through several dispatch paths.
These commands are `press`/`click`/`fill`/`longpress` and, by extension, the read/wait surfaces built on the same resolution machinery.
Each path independently selected its latency-vs-semantics trade-offs:

| Path | What it is | Why it exists |
| --- | --- | --- |
| `runtime-selector` | daemon tree capture → `resolveSelectorChain` → guards → coordinate tap | full semantics |
| `runtime-ref` | session snapshot → ref lookup → guards → coordinate tap | full semantics |
| `target-drag` | independently resolve source + destination → guards → one pointer plan | dual-endpoint drag semantics |
| `direct-ios-selector` | selector sent to the XCTest runner, which queries and taps natively | avoids a full snapshot round trip |
| `native-ref` | `backend.tapTarget`/`fillTarget` for `click @ref` / `fill @ref` | avoids resolution round trips |
| `coordinate` | raw x/y tap | escape hatch; semantics intentionally minimal |
| replay/maestro variants | `allowNonHittableCoordinateFallback`, replay-heal | third-party compatibility |

Over one week of fixes, every interaction bug that we shipped or caught had the same pattern.
One path enforced a guarantee, and a sibling path silently did not have it:

- Off-screen refusal existed for `@ref` targets, but not for selector targets and not in the runner's native tap.
  A closed Bluesky drawer reported `Tapped (-161, 265)` as success. #1075 fixed this.
- `press @ref` attached `--verify` evidence.
  The hand-built response branch of `fill @ref` dropped it (#1064 review).
- adb failure classification enriched thrown errors, but not errors from `allowFailure` results.
  The classification wrapped `exec`, but not semantic provider methods (#1067 review).
- The user's wait budget bounded prepare/replay/snapshot request envelopes, but not `wait` itself.
  Also, `wait` was on the daemon-reset timeout path, while `snapshot`, with the same failure mode, preserved the daemon (#1075).

The guarantees themselves are small and well implemented.
The missing part is a structure that knows the full set of paths and the full set of guarantees, and can therefore detect an unfilled cell.
Reviews find such a cell only if a reviewer happens to know both axes at the same time.
Dogfooding finds such cells one production incident at a time.

## Decision

Make the path × guarantee matrix a first-class, machine-checked artifact with three enforcement layers.
Types enforce **completeness** of declarations.
Shared implementations prevent **drift**.
Generated test coverage enforces **truth**.

### Layer 1 — Declare: the matrix as a typed registry with a gate

Layer 1 is an **honesty/completeness gate, not a truth gate**.
It proves that every path declares a stance on every guarantee and that the referenced implementations exist.
It does not prove the declared behavior.
Behavioral parity starts only after the fixture tables (Layer 2) and the contract scenarios (Layer 3) are in place.
Layer 1 alone still changes the failure mode: an unwatched cell becomes impossible.
An unproven cell is at least a visible claim that has an owner.

`packages/contracts/src/interaction-guarantees.ts` declares both axes and requires classification of every cell:

```ts
export const INTERACTION_GUARANTEES = [
  'disambiguation',        // collapse one equivalent wrapper chain; distinct subtrees fail with candidates
  'occlusion',             // covered targets are refused
  'offscreen',             // tap point (rect center) must lie in the root viewport
  'nonHittable',           // promotion + targetHittable/hint annotation
  'responseConstruction',  // one shared response construction site (Layer 2)
  'responseIdentity',      // refLabel/selectorChain availability on this path
  'verifyEvidence',        // --verify baseline + post-action digest
  'errorTaxonomy',         // no-match/ambiguous/offscreen codes, messages, hints
] as const;
```

If a guarantee exists only for a subset of the path's commands, cells may be **command-scoped** through `appliesTo`.
For example, `verifyEvidence` applies to `press`/`click`/`fill`, but not to `longpress`.
A path-wide claim would overstate coverage.
The gate rejects an `appliesTo` entry that names a command that the path does not dispatch.
The gate also rejects a redundant `appliesTo` list that covers all commands of the path.

`responseConstruction` and `responseIdentity` are deliberately separate.
"Use one shared construction site" and "which identity fields this path can provide" have different closure strategies.
The former is a single Layer-2 refactor.
The latter is per-path capability work.
`errorTaxonomy` is expected to split the same way later:

- Stable codes and fallback classification.
- Rich selector diagnostics and hints.

The reason is that direct runner paths can close codes long before full diagnostics.

```ts

export type GuaranteeEnforcement =
  | { kind: 'runtime'; via: string }                    // shared TS implementation (symbol name)
  | { kind: 'runner'; via: string; parityTable?: string } // Swift twin; parityTable optional until Layer 3, required once the cell claims parity
  | { kind: 'delegated'; to: InteractionPathId }        // path defers (e.g. direct → runtime on ELEMENT_OFFSCREEN)
  | { kind: 'waived'; reason: string; trackingIssue?: string }; // explicit, reviewed waiver; gap waivers must carry a tracking issue

export const INTERACTION_DISPATCH_PATHS: Record<
  InteractionPathId,
  {
    description: string;
    commands: readonly string[];
    guarantees: Record<InteractionGuarantee, GuaranteeEnforcement>;
  }
> = { /* every path, every cell */ };
```

`guarantees` is a `Record` over the guarantee union.
Thus, **tsc fails** if someone adds a guarantee without a classification for every path.
tsc also fails if someone adds a path without a classification of every guarantee.
The unit gate `interaction-guarantees.test.ts` also checks that:

- Every `via` string resolves to a real exported symbol, so declarations cannot become fiction.
- Every `parityTable` names an existing fixture file.
- Every `waived` reason is non-empty.
- Every `gap:` waiver carries a `trackingIssue`.

Waivers must have an owner, not only visibility.
One umbrella tracking issue is sufficient, with sub-issues split off when work is scheduled.
The gate enforces the link, not the granularity.

This repository already proved the same "make the gap declare itself" pattern in two places:

- `scripts/integration-progress-model.ts`, which caught the unclassified `--verify` flag on #1064.
- The cross-command apple-leak guard from the platform consolidation (ADR 0009).

### Layer 2 — Share: one implementation per rule, on both sides of the wire

Each guarantee has exactly one home that all TypeScript paths import.
Most of these homes already exist after #1075:

- `isNodeVisibleOnScreen`.
- `accumulateDisambiguationCandidate`.
- `isSnapshotNodeInteractionBlocked`.
- `describeResolvedNode`.
- `interactionResultExtra`.
- `reconcileNonHittableHintWithEvidence`.

The registry's `via` fields point at them.
Fallow's duplication gate prevents re-implementations from coming back.

Some rules must run **runner-side**, because the direct iOS path cannot see the daemon tree.
These rules get pure-function Swift twins that operate on plain geometry, without `XCUIElement`.
`TapPointPolicy.isAllowed(elementFrame:windowFrame:)` is one example.
**Golden fixture tables** enforce parity.
These tables are JSON files under `contracts/fixtures/`, and three test suites consume them:

1. Vitest asserts the TypeScript rule against the table.
2. Runner Swift unit tests assert the Swift twin against the same table.
   CI already compiles them through "Swift Runner Unit Compile".
3. The provider harness's fake runner derives its behavior from the table.
   Integration scenarios therefore exercise the real contract instead of a manual approximation.

Then, a TypeScript or Swift drift turns CI red on the side that changed, without a simulator.

`contracts/fixtures/dispatch-disclosure.json` is the table for `AppErrorDetails.dispatched` on interaction failures.
It has one row for each producer event, and each row has the value that the producer must leave.
The field has two values:

- `no`: the operation never reached the device, or the command is a read, so a resend is safe.
- `unknown`: the operation may have reached the device, so observe before a resend.

Only a producer that refuses before dispatch (target resolution, admission, a runner pre-send refusal) may report `no`.
No producer can prove execution on its failure path, so there is no third value.

Each request owns one dispatch ledger.
Every bound runtime operation declares its effect once, in `RUNTIME_OPERATION_EFFECTS`, a record over the runtime operation keys.
Thus, an operation cannot bind without an effect.
When the send of a `mutates` operation returns, the request binding records the operation in the request's ledger.
Thus, no bound runtime operation sends a mutation outside the ledger.
Android ANR and blocking-dialog recovery is outside the ledger.
Its `AndroidObservationAdapter.tap` and `openApp` calls reach the device without a record.
A nested request records into a ledger of its own and moves its sends into its parent's ledger.
A batch step, a replay action, and a delegated `find` click or fill are nested requests.

The request router discloses around every routed command.
After the ledger holds a sent mutation, a failure is `unknown`, with the sent count in `details.dispatchedSteps`.
This applies whatever produced the failure and whatever the command declares.
The reason: a wrong `no` makes a consumer resend an action that already ran, while a wrong `unknown` only costs an observation.
Before the ledger holds a sent mutation, the registry's `recordingEffect` decides:

- For `'mutates-app'`, the router keeps a producer's value.
  If no producer classified the failure, the router fills `unknown`.
- For `'observes-app'`, the router sets `no` over any producer value.
- A command with no declared effect passes through.

For a read, `no` means that a resend repeats no app-visible action.
The registry declares `record`, `trace`, and `perf` as `'observes-app'`, although their recorder and profiler controls reach the device.
There are two reasons:

- No registry trait separates a pure read from a device control.
- `RUNTIME_OPERATION_EFFECTS` declares those controls `repeatable` at the operation level, because the device refuses or ignores a repeat.

A producer can run several device inputs inside one bound operation, such as an Android double tap or an iOS press series.
That producer counts the inputs in `details.dispatchedSteps` itself, because the ledger sees one operation.

Each row names its driver file by id prefix, and that file drives the real producer.

The Apple runner does not resend a mutating command whose first send may have run.
A restart resends only a command that the first attempt provably did not write, or a read-only command.
A mutation reply can stay lost: the runner dies mid-command, or status recovery finds neither a retained result nor a runner answer.
In that case, the mutation fails with `reason: runner_reply_lost` and `dispatched: unknown`.
The rows for this case are:

- `ios-runner.transport.written-then-lost`.
- `ios-runner.status.completed-without-retained-reply`.
- `ios-runner.status.accepted`.
- `ios-runner.status.started`.
- `ios-runner.status.notAccepted`.
- `ios-runner.status.probe-failed`.
- `ios-runner.status.unavailable`.

The `ios-runner.status.failed*` rows carry the runner's own answer instead.
A read keeps its transport error and is resent.

Remaining gaps: a failure before the router's locked scope (session resolution, lock acquisition, lease and daemon-policy admission) never reaches the disclosure and carries no `dispatched`.
Such a failure sends nothing, but a consumer must read the absent field as `unknown`.

`runBatch` reports `no` only if every executed step is a command declared `observes-app` (a read).
Any other executed step makes the batch failure `unknown`, including a step with no declared `recordingEffect`.
This applies to every caller, including a caller that supplies its own `invoke`.

For `responseFields`, one `buildInteractionResponseData(...)` becomes the only construction site for interaction response payloads.
This deletes the class of bug where `fill @ref` rebuilt its response by hand and dropped `evidence`.
A small guard test, with precedent in this repository, fails if an interaction handler contains a hand-rolled `responseData = {` literal.

### Layer 3 — Prove: a contract suite generated from the registry

`test/integration/interaction-contract/` holds table-driven scenarios: fixture tree × command × forced path.
The fixture trees are the real shapes that found this week's bugs, and the suite keeps them permanently:

- Closed drawer (all candidates off-screen) → `offscreen_selector`/`offscreen_ref`.
- Stale or unknown `@ref` (errorTaxonomy) → `ref_not_found` beside the stale-ref hint.
- A listed `@ref` whose node has no usable centre (missing, non-finite, or negative bounds), or a selector target without one → `target_bounds_invalid`.
- A listed `@ref` with no label to wait on or to scope by → `ref_unlabeled`.
- Drawer item + visible twin (ambiguous on/off-screen) → the visible candidate wins.
- Edge-grazing container (0.07 px viewport overlap, center off-screen) → still refused.
- Covered node → occlusion refusal.
- Non-hittable target ± `--verify` → hint present / suppressed by evidence.
- Stripped-root tree (no Application/Window) → safe-default visibility.

Path forcing is explicit and test-only: `AGENT_DEVICE_FORCE_INTERACTION_PATH=runtime|direct|native-ref`.
Thus, cases stay stable when path-selection heuristics change.

The gate closes the loop.
It walks the Layer-1 registry and fails if any non-waived cell has no contract case tagged for it.
Coverage of the matrix therefore comes from construction, not from reviewer memory.

### Closing the gaps: a hybrid strategy, not one answer

The acknowledged gaps close by different mechanisms, which depend on what the guarantee needs:

- **Runner-side parity for cheap geometry-local rules** (offscreen/tappable-frame on the direct iOS path).
  These rules are pure frame math, golden tables can prove them, and they keep the fast path fast.
- **Delegation-on-error for semantic and rich-runtime cases** (`ELEMENT_OFFSCREEN`, `AMBIGUOUS_MATCH`, `ELEMENT_NOT_FOUND`, non-hittable refusal).
  The fast path fails cheaply.
  The runtime path supplies disambiguation and full diagnostics only when they are necessary.
  **Delegation-on-error is not success-path parity.**
  It cannot catch the case where XCTest finds one hittable candidate that runtime rules would refuse or rank differently.
  Those cells stay `gap:` waivers until parity tables or contract scenarios prove the success path too.
- **A shared runtime preflight for the native-ref path.** The ref came from a daemon snapshot, so the node is already available.
  Check offscreen, occlusion, and non-hittable against that node *before* the call to `tapTarget`/`fillTarget`.
  A backend fast path can silently "succeed", so delegation-on-error would never start there.

### Timeout policy joins the descriptor registry

The `wait` timeout bug existed because two hand-maintained lists in the client held request-envelope budgets and on-timeout daemon policy.
The two lists were `isExplicitTimeoutCommand` and `shouldResetDaemonAfterRequestTimeout`.
Declarations on the command descriptors (ADR 0008 registry) replace both lists:

```ts
timeoutPolicy: {
  budget: { source: 'flag' | 'positional-parser' | 'none'; parser?: string };
  onTimeout: 'preserve-daemon' | 'reset-daemon';
}
```

A completeness gate covers all public commands.
Read-only polling commands declare `preserve-daemon`.
The client derives the envelope from the declared budget source, instead of special cases for command names.
Since #1105, the capture-resolving interaction commands also declare `preserve-daemon`:

- `click`.
- `fill`.
- `longpress`.
- `press`.
- `type`.
- `get`.
- `is`.

Their dominant timeout mode is the same blocked accessibility capture as `snapshot`.
A daemon reset there destroyed every healthy app session that the daemon owned.

## Consequences

- A new dispatch path or a new guarantee forces a whole-matrix decision.
  tsc does not compile an unclassified cell, and the gate does not pass an untested cell.
  Silent erosion is structurally impossible.
  Explicit waivers remain possible, but they are visible and can link to issues.
- Fast paths keep their latency wins.
  Their divergence is priced and documented, instead of discovered on-device.
- The Swift/TypeScript split stops being a parity blind spot.
  Golden tables are the single source of truth for cross-language rules.
  The fake runner stops being a second implementation that drifts.
- The initial cost is mostly classification honesty.
  The first registry contains `waived('gap: ...')` cells, and that is the purpose.
  For example, the maestro non-hittable fallback intentionally waives `offscreen`.
  The debt becomes a diffable list instead of folklore.
- The registry is also documentation input for help/skill output ("what press guarantees").
  This matters for small-model agents that only read the contract, never the code.

### 2026-08-07 amendment: mutating ambiguity fails fast

Element-14 made the matrix's previously owned success-path gap real.
Four exact `Team Standup` matches in distinct accessibility subtrees reached ordinary runtime selector resolution.
Its visible/depth/area ranking silently chose a different semantic target.
Mutating selectors no longer use geometry to choose among distinct subtrees.

The replacement contract is structural.
Multiple matches collapse only if all matches form one ancestor–descendant chain and every member resolves to the same actionable node.
Otherwise, the mutation fails with `AMBIGUOUS_MATCH`, a bounded list of snapshot candidate lines, and a partial ref frame generation.
Thus, the caller can immediately retry one listed candidate.
On the direct XCTest path, this applies only to mutating dispatches.
They count all raw exact matches before hittability can select a winner, and they delegate multiple matches to the runtime classifier.
Reads (`querySelector`, and so `get`/`is`/`wait`) keep the prior rule:

- Prefer the single hittable match.
- Report ambiguity only if hittable matches compete.

The reason: a read has no side effect to guard, and a fail-closed read would turn a decorative duplicate into an error.
Maestro's explicit expected-point/non-hittable compatibility path remains intentionally separate.

### 2026-09-11 amendment: one collapse for one control, at both doors

Two clauses of the amendment above became stale when the read paths moved.
Also, the structural rule never reached the read door.

- `querySelector` no longer backs `get`/`is`/`wait`.
  Those reads resolve against a capture, through the `readUnique`/`readAny`/`readText` rows of `packages/selectors/src/selector-pipeline.ts`.
  Thus, the runner's hittable-preference rule governs only the direct XCTest paths that still query it: the direct-iOS touch fast path and the off-screen target probe.
- A control reported through its own accessibility wrapper answers a selector twice.
  A regular iOS snapshot omits unverified hittability, so the ladder that relates a wrapper to its control cannot fire.
  #2482 collapsed that chain for mutating resolution only.
  As a result, `is visible` and `get attrs` refused the same screen as ambiguous, while `press` tapped it.
  The collapse now sits beside the classification that asks for it (`resolveUnverifiedWrapperControl`).
  The collapse applies where a refusal was the answer.
  The uniqueness rows resolve the control instead of reporting no match:
  - `is <predicate>`.
  - `get attrs`.
  - `screenshot --crop-on`.
  The collapse does not touch a row that resolves before any refusal.
  A wrapper chain always resolves before a refusal, because depth separates a wrapper from its control.
  Thus, `get text` ranks onto the control.
  `wait`/`is exists` answer from the document-order head, and do not ask which element was meant.
  A candidate set that the rule does not recognize as one control still refuses.
  A cell and the button inside it, or matches in distinct subtrees, are such candidate sets.
- Replay verifies a recorded target: it resolves the recorded selector again under the same row's refusal rules.
  Thus, the screen that dispatch had resolved read as an identity mismatch on the first replay of the step.
  Verification names the collapsed control too.
  That control is the node that dispatch acted on, and the node that the recorded identity carries.

### Synthesized iOS gesture policy

The element dispatch-path matrix above intentionally does not include synthesized iOS gestures:

- `scroll`.
- Synthesized coordinate `tap`.
- Synthesized `drag`.
- Synthesized `sequence` tap/drag steps.

They do not resolve selectors or refs, so a claim of the element-targeting guarantees would be misleading.
Their AX-health, keyboard-probe, frame-source, activation-preflight, and XCTest-coordinate fallback rules stay runner-local in `RunnerTests+SynthesizedGesturePolicy.swift`.
That Swift policy is the source of truth, because the current table has only three behaviors:

- A coordinate synthesized tap never probes keyboards and may use the coordinate fallback.
  This applies to a standalone tap, a `sequence` step, and the in-app `back` top-leading tap.
- Default iOS scroll probes keyboards only after AX is known healthy.
  It must not fall back to `XCUICoordinate`.
- Synthesized one-contact `gesture` plans may still use the coordinate fallback before AX health is known.
  After a snapshot stamps AX unavailable, they stop using it.

Gated XCTest policy tests cover the non-obvious parts, instead of a cross-language mirror.
A future sibling registry should be introduced only once one of these conditions is true:

- Gesture policy grows beyond this small runner-local table.
- Host-side tooling needs to consume gesture policy directly.

Synthesized coordinate contexts use screenshot dimensions as their only frame source.
They intentionally exclude cheaper frame sources, such as:

- `app.frame`.
- Windows.
- Accessibility frames.
- Native screen bounds.

The reason: those sources can diverge from full-screen screenshot coordinates on affected simulators.

Target-authored `gesture drag` is classified as the `target-drag` path above, because it resolves two elements.
Therefore, it inherits the element guarantees and the ADR 0012 identity requirements for both elements.
Coordinate-authored drag remains outside this matrix.

The typed gesture-plan contract in [ADR 0013](0013-unified-gesture-plans.md) now owns two-contact pan/pinch/rotate/transform planning.
That contract remains a sibling of this element-targeting matrix.
A coordinate gesture does not acquire selector/ref guarantees only because its native executor uses XCTest.

## Migration plan

Each step lands green and is independently useful.
Steps 1, 2, 4, and 5 are complete, and git history keeps them.
Step 3 is not complete:

3. **Golden fixture tables** + `TapPointPolicy` Swift extraction + the three consumers (vitest, XCTest, fake runner).

## Alternatives considered

- **Delete the fast paths** (single resolution spine): unacceptable.
  The direct iOS path saves a full snapshot round trip per interaction.
  The ref fast path is the backbone of replay throughput.
  The problem is not that fast paths exist.
  The problem is that their trade-offs were implicit.
- **Typestate/branded types** ("cannot construct a response without proof the guards ran"): this cannot reach across the wire into Swift.
  Also, the proof tokens would spread through every signature, for a marginal gain over the registry-plus-gate split.
  Types are used where they are strongest: completeness of the declaration.
  Tests are used where they are strongest: truth of the declaration.
- **More integration tests without the registry**: this is the status quo plus effort.
  Without the matrix as code, nothing forces a new path to acquire the existing suite.
  That is exactly how this week's bugs happened.

### Optional observation before an iOS coordinate tap

A coordinate tap must not depend on a preceding XCTest snapshot failure.
Its optional text-input lookup may establish a concrete identity for a later bare `type`.
An absent or unavailable lookup establishes no typing witness.
A runner snapshot penalty can skip this work, but the penalty is only a performance optimization.

The lookup owns a thread-bound issue scope in the runner recorder and returns a typed result.
Any recorded issue discards partial candidates, including an issue that AX suppression otherwise handles.
The scope excludes gesture dispatch and required text-entry reads.
Those failures retain the existing mutation-outcome rules.

The iOS PR lane exercises:

- A fresh runner with an unavailable probe.
- A suppressed AX issue with a matching candidate.
- A healthy coordinate tap followed by typing.
- Failures outside the optional observation scope.

These tests must not seed a snapshot penalty to make the first tap safe.

The recorder consumes optional-read issues before it forwards issues to XCTest.
XCTest's expected-failure API must not own this scope.
The reason: in a long-lived command test, that API can complete the enclosing test even if the command response succeeds.
