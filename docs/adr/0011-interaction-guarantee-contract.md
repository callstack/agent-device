# ADR 0011: Interaction Guarantee Contract (path × guarantee matrix)

## Status

Accepted

Completed process history is in git history.

## Rules at a glance

- Classify every dispatch-path × guarantee cell in the typed registry.
- Link each gap waiver to a tracking issue. Keep command-scoped claims within the path's command set.
- Give each TypeScript rule one shared implementation. Prove runner-side equivalents through golden fixtures.
- Prove every non-waived cell through a tagged contract scenario.
- Delegation-on-error does not prove success-path parity.
- Before native-ref execution, apply shared guards to the stored node.
- Never resend an Apple mutation that may have run.
- Distinct mutating selector subtrees fail with `AMBIGUOUS_MATCH`, except for the stated compatibility path.
- Keep synthesized coordinate gesture policy separate from element-targeting guarantees.

## Context

Interaction commands reach the device through several dispatch paths.
These commands include `press`/`click`/`fill`/`longpress` and related read/wait surfaces that share resolution machinery.
Each path independently selected its latency and semantic compromises:

| Path | What it is | Why it exists |
| --- | --- | --- |
| `runtime-selector` | daemon tree capture → `resolveSelectorChain` → guards → coordinate tap | full semantics |
| `runtime-ref` | session snapshot → ref lookup → guards → coordinate tap | full semantics |
| `target-drag` | independently resolve source + destination → guards → one pointer plan | dual-endpoint drag semantics |
| `direct-ios-selector` | selector sent to the XCTest runner for native query and tap | avoids a full snapshot round trip |
| `native-ref` | `backend.tapTarget`/`fillTarget` for `click @ref` / `fill @ref` | avoids resolution round trips |
| `coordinate` | raw x/y tap | explicit minimal semantics |
| replay/maestro variants | `allowNonHittableCoordinateFallback`, replay-heal | third-party compatibility |

During one week, every shipped or detected interaction bug had the same cause.
One path enforced a guarantee that another path silently omitted:

- Offscreen refusal covered `@ref` targets but omitted selector targets and native runner taps.
  A closed Bluesky drawer reported success as `Tapped (-161, 265)` (#1075).
- `press @ref` attached `--verify` evidence.
  The manually constructed response for `fill @ref` omitted it (#1064 review).
- adb failure classification enriched thrown errors but omitted errors from `allowFailure` results.
  It wrapped `exec` but omitted semantic provider methods (#1067 review).
- The user's wait budget bounded prepare/replay/snapshot envelopes but omitted `wait` itself.
  A `wait` timeout reset the daemon, while the same failure in `snapshot` preserved it (#1075).

The guarantees are small and well implemented.
The missing structure enumerates every path and every guarantee to detect an unclassified cell.
Reviews otherwise depend on simultaneous knowledge of both axes.
Live use detects the gaps only after incidents.

## Decision

Make the path × guarantee matrix a machine-checked artifact with three enforcement layers.
Types enforce declaration **completeness**.
Shared implementations prevent **drift**.
Generated test coverage enforces **truth**.

### Layer 1 — Declare: the matrix as a typed registry with a gate

Layer 1 proves **honesty/completeness**, not behavior.
It proves that every path declares a position on every guarantee and that referenced implementations exist.
Behavioral parity additionally requires Layer 2 fixture tables and Layer 3 contract scenarios.
Layer 1 alone prevents an undeclared cell.
An unproven cell remains a visible claim with an owner.

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

When a guarantee applies to only some path commands, cells may use command-scoped `appliesTo`.
For example, `verifyEvidence` applies to `press`/`click`/`fill`, but not `longpress`.
A path-wide claim would overstate coverage.
The gate rejects commands outside the path and redundant lists that cover all path commands.

`responseConstruction` and `responseIdentity` remain separate.
A shared construction site and available identity fields need different completion strategies.
The former requires one Layer-2 refactor.
The latter requires per-path capability work.
`errorTaxonomy` is expected to split similarly later:

- Stable codes and fallback classification.
- Rich selector diagnostics and hints.

Direct runner paths can implement codes before full diagnostics.

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
Thus, **tsc fails** if a new guarantee lacks classification for every path or a new path lacks any guarantee classification.
The unit gate `interaction-guarantees.test.ts` also verifies:

- Every `via` string resolves to a real exported symbol.
- Every `parityTable` names an existing fixture file.
- Every `waived` reason is non-empty.
- Every `gap:` waiver has a `trackingIssue`.

Waivers require ownership as well as visibility.
One umbrella issue is sufficient, with sub-issues added when work is scheduled.
The gate enforces the link, not issue granularity.

The repository already uses this explicit-gap pattern in `scripts/integration-progress-model.ts` and ADR 0009's cross-command apple-leak guard.
The progress model detected the unclassified `--verify` flag on #1064.

### Layer 2 — Share: one implementation per rule, on both sides of the wire

Each guarantee has exactly one owner imported by every TypeScript path.
Existing owners include:

- `isNodeVisibleOnScreen`.
- `accumulateDisambiguationCandidate`.
- `isSnapshotNodeInteractionBlocked`.
- `describeResolvedNode`.
- `interactionResultExtra`.
- `reconcileNonHittableHintWithEvidence`.

The registry's `via` fields identify them.
Fallow's duplication gate prevents new duplicate implementations.

Rules that must execute runner-side use pure-function Swift equivalents over plain geometry, without `XCUIElement`.
The direct iOS path cannot see the daemon tree.
`TapPointPolicy.isAllowed(elementFrame:windowFrame:)` is one example.
**Golden fixture tables** under `contracts/fixtures/` enforce parity through three consumers:

1. Vitest asserts the TypeScript rule against the table.
2. Runner Swift unit tests assert the Swift equivalent against the same table.
   CI already compiles them through "Swift Runner Unit Compile".
3. The provider harness's fake runner derives its behavior from the table.
   Integration scenarios therefore exercise the real contract instead of a manual approximation.

A TypeScript or Swift difference fails CI on the changed side without a simulator.

`contracts/fixtures/dispatch-disclosure.json` defines `AppErrorDetails.dispatched` on interaction failures.
Each producer event has one row with its required value:

- `no`: the operation never reached the device, or the command is a read, so a resend is safe.
- `unknown`: the operation may have reached the device, so observe before resend.

Only pre-dispatch refusals from target resolution, admission, or runner pre-send checks may report `no` for an operation.
No producer can prove execution on its failure path, so no third value exists.

Each request owns one dispatch ledger.
Every bound runtime operation declares its effect once in `RUNTIME_OPERATION_EFFECTS`, a record over runtime operation keys.
An operation cannot bind without an effect.
When a send returns, the request binding records each `mutates` operation in that request's ledger.
Thus, no bound runtime operation sends an unrecorded mutation.
Android ANR and blocking-dialog recovery remain outside the ledger.
Their `AndroidObservationAdapter.tap` and `openApp` calls reach the device without a record.
A nested request has its own ledger and transfers its sends to its parent's ledger.
Examples include batch steps, replay actions, and delegated `find` clicks or fills.

The request router adds disclosure around every routed command.
After a sent mutation enters the ledger, any failure reports `unknown` and the sent count in `details.dispatchedSteps`.
This overrides both producer output and command declarations.
An incorrect `no` could cause a consumer to repeat an action that ran.
An incorrect `unknown` costs only an observation.
Before any sent mutation, registry `recordingEffect` controls disclosure:

- For `'mutates-app'`, preserve the producer's value.
  If no producer classified the failure, supply `unknown`.
- For `'observes-app'`, set `no` over any producer value.
- Without a declared effect, preserve the response unchanged.

For reads, `no` means a resend repeats no app-visible action.
The registry declares `record`, `trace`, and `perf` as `'observes-app'`, although recorder/profiler controls reach the device.
No registry trait separates pure reads from device controls.
Those operations are `repeatable` because the device refuses or ignores a repeat.
If one bound operation performs several inputs, its producer counts them in `details.dispatchedSteps` because the ledger sees only one operation.
Examples include an Android double tap and an iOS press series.

Each fixture row's id prefix identifies its driver file.
That file exercises the real producer.

The Apple runner does not resend a mutation whose first send may have run.
After restart, it resends only a read-only command or a command that the first attempt provably did not write.
If a mutation's reply remains lost, failure carries `reason: runner_reply_lost` and `dispatched: unknown`.
This applies if the runner dies mid-command or status recovery finds neither a retained result nor a runner answer.
The fixture rows are:

- `ios-runner.transport.written-then-lost`.
- `ios-runner.status.completed-without-retained-reply`.
- `ios-runner.status.accepted`.
- `ios-runner.status.started`.
- `ios-runner.status.notAccepted`.
- `ios-runner.status.probe-failed`.
- `ios-runner.status.unavailable`.

The `ios-runner.status.failed*` rows instead carry the runner's own answer.
A read retains its transport error and is resent.

An evidence gap remains before the router's locked scope.
Failures in session resolution, lock acquisition, lease admission, or daemon-policy admission never reach disclosure and carry no `dispatched`.
They send nothing, but consumers must interpret absence as `unknown`.

`runBatch` reports `no` only if every executed step declares `observes-app`.
Any other executed step makes the batch failure `unknown`, including steps without `recordingEffect`.
This applies to every caller, including callers with their own `invoke`.

For `responseFields`, `buildInteractionResponseData(...)` becomes the only construction site for interaction response payloads.
This prevents manual branches such as `fill @ref` from omitting `evidence`.
A small guard test follows repository precedent.
It fails if an interaction handler contains a manual `responseData = {` literal.

### Layer 3 — Prove: a contract suite generated from the registry

`test/integration/interaction-contract/` contains table-driven scenarios: fixture tree × command × forced path.
Permanent fixture trees preserve the real failure shapes:

- Closed drawer with all candidates offscreen → `offscreen_selector`/`offscreen_ref`.
- Stale or unknown `@ref` → `ref_not_found` with the stale-ref hint.
- Listed `@ref` or selector target without a usable center → `target_bounds_invalid`.
  Bounds can be missing, non-finite, or negative.
- Listed `@ref` without a label for wait or scope → `ref_unlabeled`.
- Drawer item and visible twin → visible candidate wins despite on/offscreen ambiguity.
- Container with 0.07 px viewport overlap and offscreen center → refusal.
- Covered node → occlusion refusal.
- Non-hittable target with or without `--verify` → hint present or suppressed by evidence.
- Stripped-root tree without Application/Window → safe-default visibility.

Tests force paths explicitly with `AGENT_DEVICE_FORCE_INTERACTION_PATH=runtime|direct|native-ref`.
This test-only control keeps cases stable when path selection heuristics change.
The gate traverses the Layer-1 registry.
It fails if a non-waived cell has no tagged contract case.
Thus, construction enforces matrix coverage without reviewer memory.

### Closing the gaps: a hybrid strategy, not one answer

Different guarantees require different mechanisms to close acknowledged gaps:

- **Runner-side parity for low-cost geometry-local rules.** Direct iOS offscreen/tappable-frame rules use pure geometry proven by golden tables.
  They preserve the fast path's latency.
- **Delegation-on-error for semantic and rich-runtime cases.** These include `ELEMENT_OFFSCREEN`, `AMBIGUOUS_MATCH`, `ELEMENT_NOT_FOUND`, and non-hittable refusal.
  The fast path fails at low cost.
  The runtime path supplies disambiguation and full diagnostics only when required.
  **Delegation-on-error does not prove success-path parity.**
  XCTest may find one hittable candidate that runtime rules would refuse or rank differently.
  Those cells retain `gap:` waivers until parity tables or contract scenarios also prove success-path behavior.
- **Shared runtime preflight for native-ref.** The daemon snapshot already contains the ref's node.
  Before `tapTarget`/`fillTarget`, examine offscreen, occlusion, and non-hittable conditions against that node.
  A backend fast path can silently succeed, so delegation-on-error would never run.

### Timeout policy joins the descriptor registry

Two manually maintained client lists caused the `wait` timeout defect:

- `isExplicitTimeoutCommand` controlled request-envelope budgets.
- `shouldResetDaemonAfterRequestTimeout` controlled timeout daemon policy.

Command descriptors in ADR 0008 replace both lists with declarations:

```ts
timeoutPolicy: {
  budget: { source: 'flag' | 'positional-parser' | 'none'; parser?: string };
  onTimeout: 'preserve-daemon' | 'reset-daemon';
}
```

A completeness gate covers every public command.
Read-only polling commands declare `preserve-daemon`.
The client derives the envelope from the declared budget source instead of command-name exceptions.
Capture-resolving interactions also declare `preserve-daemon` (#1105):

- `click`.
- `fill`.
- `longpress`.
- `press`.
- `type`.
- `get`.
- `is`.

Like `snapshot`, their dominant timeout cause is blocked accessibility capture.
A daemon reset would destroy every healthy app session it owns.

## Consequences

- A new path or guarantee requires a whole-matrix decision.
  tsc rejects unclassified cells, and the gate rejects untested cells.
  Silent loss is structurally impossible.
  Explicit waivers remain possible, visible, and linked to issues.
- Fast paths retain latency benefits with documented differences and costs.
- Golden tables become the single source of truth for cross-language rules.
  The fake runner no longer provides a second implementation that can diverge.
- Initial classification includes `waived('gap: ...')` cells.
  For example, the maestro non-hittable fallback intentionally waives `offscreen`.
  The debt becomes a reviewable list instead of undocumented knowledge.
- The registry also supplies documentation input for help/skill output, such as the guarantees of press.
  This matters for small-model agents that read contracts without code.

### 2026-08-07 amendment: mutating ambiguity fails fast

Element-14 demonstrated the owned success-path gap with four exact `Team Standup` matches in distinct accessibility subtrees.
Ordinary runtime selector resolution silently selected a different semantic target through visible/depth/area ranks.
Mutating selectors no longer use geometry to select between distinct subtrees.

The replacement contract is structural.
Multiple matches collapse only if all form one ancestor–descendant chain and every member resolves to the same actionable node.
Otherwise, mutation fails with `AMBIGUOUS_MATCH`.
It returns bounded snapshot candidate lines and a partial ref frame generation for immediate retry with one listed candidate.
On direct XCTest paths, this applies only to mutating dispatches.
They count all raw exact matches before hittability can select a candidate.
Multiple matches delegate to the runtime classifier.
Reads through `querySelector`, and thus the original `get`/`is`/`wait` paths, retain the prior rule:

- Prefer the single hittable match.
- Report ambiguity only if hittable matches compete.

Reads have no side effect to protect.
A closed failure would turn a decorative duplicate into an error.
The amendment below updates which paths still use `querySelector`.
Maestro's explicit expected-point/non-hittable compatibility path remains intentionally separate.

### 2026-09-11 amendment: one collapse for one control, at both doors

Two earlier clauses became stale after read paths changed.
The structural rule also needed to apply to reads:

- `querySelector` no longer serves `get`/`is`/`wait`.
  These reads resolve a capture through `readUnique`/`readAny`/`readText` in `packages/selectors/src/selector-pipeline.ts`.
  The runner's hittable-preference rule therefore governs only remaining direct XCTest queries: direct-iOS touch fast path and offscreen target probe.
- A control's accessibility wrapper can make one selector match twice.
  Regular iOS snapshots omit unverified hittability, so the wrapper-to-control relation cannot use that evidence.
  A mutation-only collapse (#2482) let `press` succeed while `is visible` and `get attrs` reported ambiguity on the same screen.
  `resolveUnverifiedWrapperControl` now places collapse beside its classification.
  Uniqueness rows that otherwise refuse resolve the control:
  - `is <predicate>`.
  - `get attrs`.
  - `screenshot --crop-on`.
  Rows that resolve before refusal remain unchanged.
  A wrapper chain always resolves before refusal on those rows.
  Depth makes `get text` rank the control above its wrapper.
  `wait`/`is exists` use the first document-order match without requiring unique identity.
  Candidate sets outside the one-control rule still refuse.
  Examples include a cell with its internal button and matches in distinct subtrees.
- Replay verifies recorded targets by resolving their selectors under the same row's refusal rules.
  Without equivalent collapse, the first replay could report identity mismatch for a target dispatch had resolved.
  Verification therefore names the collapsed control, matching both dispatch and recorded identity.

### Synthesized iOS gesture policy

Synthesized iOS gestures intentionally remain outside the element dispatch-path matrix:

- `scroll`.
- Synthesized coordinate `tap`.
- Synthesized `drag`.
- Synthesized `sequence` tap/drag steps.

They resolve neither selectors nor refs.
Element-targeting guarantee claims would therefore mislead.
`RunnerTests+SynthesizedGesturePolicy.swift` retains runner-local rules for AX health, keyboard probes, frame sources, activation preflight, and XCTest-coordinate fallback.
This Swift policy is authoritative because the current table has only three behaviors:

- Synthesized coordinate taps never probe keyboards and may use coordinate fallback.
  This includes standalone taps, `sequence` steps, and the in-app `back` top-leading tap.
- Default iOS scroll probes keyboards only after known AX health.
  It must not fall back to `XCUICoordinate`.
- Synthesized one-contact `gesture` plans may use coordinate fallback before known AX health.
  After a snapshot reports unavailable AX, they stop using it.

Gated XCTest policy tests cover the less obvious cases instead of a cross-language duplicate.
A sibling registry should be introduced only under either condition:

- Gesture policy grows beyond this small runner-local table.
- Host-side tools need to consume it directly.

Synthesized coordinate contexts use screenshot dimensions as their only frame source.
They intentionally exclude cheaper sources such as:

- `app.frame`.
- Windows.
- Accessibility frames.
- Native screen bounds.

Those sources can differ from full-screen screenshot coordinates on affected simulators.

Target-authored `gesture drag` uses the `target-drag` path because it resolves two elements.
It inherits element guarantees and ADR 0012 identity requirements for both endpoints.
Coordinate-authored drag remains outside this matrix.

[ADR 0013](0013-unified-gesture-plans.md) owns two-contact pan/pinch/rotate/transform plans.
That contract remains separate from this element-targeting matrix.
A coordinate gesture does not acquire selector/ref guarantees because its native executor uses XCTest.

## Alternatives considered

- **Delete fast paths and use one resolution path.** Unacceptable.
  Direct iOS avoids a full snapshot round trip per interaction.
  The ref fast path is central to replay throughput.
  Their implicit compromises require explicit contracts.
- **Use typestate/branded proof types.** Proof that response guards ran cannot cross the wire into Swift.
  Proof tokens would spread through every signature for little additional benefit over the registry and gate.
  Types enforce declaration completeness, while tests prove declared behavior.
- **Add integration tests without a registry.** This retains the existing failure mode with more effort.
  Without a coded matrix, no mechanism requires a new path to acquire the existing suite.

### Optional observation before an iOS coordinate tap

A coordinate tap must not depend on a preceding XCTest snapshot failure.
Its optional text-input lookup may establish concrete identity for a later bare `type`.
An absent or unavailable lookup establishes no typing witness.
A runner snapshot penalty can skip this work, but only as a performance optimization.

The lookup owns a thread-bound issue scope in the runner recorder and returns a typed result.
Any recorded issue discards partial candidates, including an issue otherwise handled by AX suppression.
The scope excludes gesture dispatch and required text-entry reads.
Those failures retain existing mutation-outcome rules.

The iOS PR lane exercises:

- A fresh runner with an unavailable probe.
- A suppressed AX issue with a matching candidate.
- A healthy coordinate tap followed by typing.
- Failures outside the optional observation scope.

These tests must not seed a snapshot penalty to make the first tap safe.
Before the recorder forwards optional-read issues to XCTest, it consumes them.
XCTest's expected-failure API must not own this scope.
In a long-lived command test, it can complete the enclosing test even if the command response succeeds.
