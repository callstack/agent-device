/**
 * The `ad-replay` package façade (#1478 P5 stage D — narrowed; report-action/
 * suggestion-ranking/vars/identity-vocabulary further narrowed by the P5
 * review pass; plan-digest/resume and `classifyTargetBindingMatch` further
 * narrowed by the #1555 review pass, "complete the binding façade instead of
 * documenting deviations"). `scripts/layering/package-boundaries.test.ts`
 * asserts this file's exact export list — see "the real tree parses,
 * declares, and passes R11" — so a stray export fails that gate, not just a
 * comment mismatch.
 *
 * The binding design (issue comment 5156017698) is `inspectAdReplay` +
 * `runAdReplay` and nothing else. As of the #1555 review pass, parsing,
 * variable substitution, planning, digest/resume, and classification are ALL
 * on-design: `inspectAdReplay`'s manifest carries the digest and the
 * `--from`/`--plan-digest` resume math internally, and
 * `classifyTargetBindingMatch` moved to its real owner,
 * `@agent-device/ad-script` (both daemon consumers — record-time self-check
 * and replay-time classification — never went through this façade at all).
 *
 * ONE deviation remains, reported rather than papered over per the review's
 * own instruction ("if a genuine remainder must stay callable from the
 * daemon, STOP and report rather than re-exporting"): the four
 * target-verification policy functions below, and the `ReplaySelectorPort`
 * type family they (and other daemon handlers) need to name. Their sole
 * caller, `session-replay-target-verification.ts`, is the daemon's
 * verify-then-dispatch orchestrator — it interleaves these PURE decisions
 * with daemon-only async work (snapshot capture, `SessionStore` reads,
 * coordinator/resume stamping, wire-response sanitization/shaping) that must
 * stay outside the engine by design. Moving the CALL SITES for these four
 * functions to live only "behind runAdReplay" would require restructuring
 * that whole orchestration into new fine-grained `AdReplayStepRuntime`
 * capabilities (e.g. a capture capability, a wire-shaping capability) so the
 * engine's own code could drive it end to end — a materially larger,
 * higher-risk change than the neutral-outcomes and plan/digest/resume work
 * in this same pass, and out of scope here; see the #1555 R2 handoff notes.
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
// derivation), split out of `session-replay-target-verification.ts`.
// façade-deviation: that same daemon wire-builder is the direct caller of
// all four functions below — see `./internal/target-verification.ts` for the
// daemon/engine ownership split.
// ---------------------------------------------------------------------------
export {
  deriveReplayTargetGuardMismatchEvidence,
  deriveWaitLandmarkMismatchEvidence,
  planPostResolutionTargetVerification,
  planPreDispatchTargetVerification,
} from './internal/target-verification.ts';
export type { ReplayPostDispatchMismatchEvidence } from './internal/target-verification.ts';

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
// the port rides in as `runAdReplay`'s runtime threads it, but the type
// itself is named at every one of those call sites.
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
