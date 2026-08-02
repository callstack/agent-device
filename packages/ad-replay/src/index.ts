/**
 * The `ad-replay` package façade (#1478 P5 stage D — narrowed; report-action/
 * suggestion-ranking/vars/identity-vocabulary further narrowed by the P5
 * review pass; plan-digest/resume and `classifyTargetBindingMatch` further
 * narrowed by the #1555 review pass, "complete the binding façade instead of
 * documenting deviations"; the target-verification policy functions further
 * narrowed by the #1555 review's R3 pass, "target verification must happen
 * INSIDE the engine"). `scripts/layering/package-boundaries.test.ts` asserts
 * this file's exact export list — see "the real tree parses, declares, and
 * passes R11" — so a stray export fails that gate, not just a comment
 * mismatch.
 *
 * The binding design (issue comment 5156017698) is `inspectAdReplay` +
 * `runAdReplay` and nothing else — as of R3, with NO reported deviation: the
 * four target-verification policy functions (`planPostResolutionTargetVerification`,
 * `planPreDispatchTargetVerification`, `deriveReplayTargetGuardMismatchEvidence`,
 * `deriveWaitLandmarkMismatchEvidence`) are called only from
 * `./internal/step-loop.ts`'s `verifyAndDispatchStep` — the step loop's own
 * verify-then-dispatch orchestration, which drives the daemon-owned pieces
 * (capture, classification, dispatch, wire-building) through narrow
 * `AdReplayStepRuntime` capabilities instead of the daemon calling the policy
 * functions directly. See `./internal/target-verification.ts` and
 * `./internal/step-loop.ts` for the split.
 */

// ---------------------------------------------------------------------------
// inspect.ts — the read-only `.ad` manifest reader. On-design: this IS one
// of the two binding-design entrypoints. #1555 review P1 ("digest/resume
// must also occur behind runAdReplay"): the plan-digest hash
// (`plan-digest.ts`, `computeReplayPlanDigest`) and the `--from`/
// `--plan-digest` resume-point math (`resume.ts`, `resolveReplayEntryIndex`)
// are internal-only now — neither is exported here. `inspectAdReplay`'s
// manifest carries the digest as `planDigest` and the resume math as a
// `resolveEntryIndex` closure instead, so `session-replay-runtime.ts`'s
// `prepareReplayPlan` and `request-router-repair-expired.test.ts` read them
// off the manifest rather than importing the underlying functions.
// ---------------------------------------------------------------------------
export { inspectAdReplay } from './internal/inspect.ts';
export type { AdReplayDigestFlags, AdReplayManifest } from './internal/inspect.ts';

// ---------------------------------------------------------------------------
// step-loop.ts — the `.ad` step loop. On-design: this IS the other binding-
// design entrypoint; `AdReplayStepRuntime` is the runtime capability bag the
// daemon adapter (`session-replay-runtime.ts`) implements to thread it.
// ---------------------------------------------------------------------------
export { formatReplaySuccessMessage, runAdReplay } from './internal/step-loop.ts';
export type {
  AdReplayRunOutcome,
  AdReplayStepFailure,
  AdReplayStepOutcome,
  AdReplayStepRuntime,
} from './internal/step-loop.ts';

// ---------------------------------------------------------------------------
// target-verification.ts — #1478 P5 stage C2a target-verification ENGINE
// policy (pre-capture verification gating, post-dispatch mismatch-evidence
// derivation). As of the #1555 review's R3 pass, its four functions are
// called ONLY from `./internal/step-loop.ts` (`verifyAndDispatchStep`) — the
// engine's own step loop, never the daemon — so nothing from this module is
// re-exported here anymore. See `./internal/target-verification.ts`'s header
// for the full daemon/engine ownership split.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// selector-port.ts — the `ReplaySelectorPort` port TYPE only (#1478 P5 stage
// B, the amendment's explicit rejection of a "seven-function selector-AST
// mirror"). Two adapters implement it: the production adapter
// (`src/daemon/replay-selector-port.ts`) and the in-memory adapter for this
// package's own contract suite, relocated to
// `src/__tests__/test-utils/in-memory-replay-selector-port.ts` (#1478 P5
// stage D — package-internal code may not "reach back into root `src/`",
// R11, so the adapter could not stay inside `packages/ad-replay` once its
// only remaining consumer was a root test).
// façade-deviation: daemon handlers thread `ReplaySelectorPort` values
// directly (`session-replay-target-token.ts`, `session-replay-heal.ts`,
// `session-replay-target-classification.ts`, `session-replay-runtime-failure.ts`,
// `session-replay-runtime.ts`, `session-replay-target-verification.ts`) —
// the port rides in as `runAdReplay`'s runtime threads it (as of R3, also as
// `AdReplayStepRuntime.port` itself, for the engine's own pre-dispatch plan),
// but the type is named at every one of those call sites too.
// ---------------------------------------------------------------------------
export type {
  ReplayRecordedTargetDisambiguation,
  ReplayRecordedTargetPolicy,
  ReplayRecordedTargetResolution,
  ReplaySelectorCandidateOptions,
  ReplaySelectorExpressionOutcome,
  ReplaySelectorGrammar,
  ReplaySelectorPort,
} from './internal/selector-port.ts';
