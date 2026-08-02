/**
 * The `ad-replay` package façade (#1478 P5 stage D — narrowed).
 *
 * The binding design (issue comment 5156017698) is `inspectAdReplay` +
 * `runAdReplay` and nothing else. Staged reality is wider than that: the
 * daemon wire-builders and handlers call several engine POLICY functions
 * directly rather than only through the two entrypoints (var substitution,
 * plan-digest, target-identity/-verification, report shaping). Every export
 * below is a `façade-deviation` from the binding-design ideal EXCEPT
 * `inspectAdReplay`/`runAdReplay` themselves; each deviation names its real
 * root consumer(s) so the PR body's deviation table is generated straight
 * from this file. No selector AST, no engine IR, no prepared-plan type, and
 * no internal subpath is exported — everything here has a live import site
 * outside this package (see `packages/ad-replay/src/index.ts`'s sibling
 * consumer grep in the P5 stage D commit message for the full map).
 */

// ---------------------------------------------------------------------------
// vars.ts — `.ad` variable substitution surface.
// façade-deviation: the daemon resolves an action's variables directly
// (`session-replay-target-verification.ts`, `session-replay-action-runtime.ts`)
// and builds/collects env-derived scopes outside the step loop
// (`session-replay-runtime.ts`, `session-replay-maestro-runtime.ts`,
// `session-replay-runtime-failure.ts`) instead of only receiving resolved
// actions back from `runAdReplay`.
// ---------------------------------------------------------------------------
export {
  buildReplayVarScope,
  collectReplayScrubbableVarValues,
  collectReplayShellEnv,
  parseReplayCliEnvEntries,
  readReplayCliEnvEntries,
  readReplayShellEnvSource,
  resolveReplayAction,
} from './internal/vars.ts';
export type { ReplayVarScope } from './internal/vars.ts';

// ---------------------------------------------------------------------------
// plan-digest.ts — the `--from`/`--plan-digest` resume and save-script digest.
// façade-deviation: `session-replay-runtime-plan.ts`'s resume path and
// `request-router-repair-expired.test.ts` compute/read the digest directly,
// ahead of and independent from any `runAdReplay` call.
// ---------------------------------------------------------------------------
export { computeReplayPlanDigest } from './internal/plan-digest.ts';
export type { ReplayPlanDigestMetadata } from './internal/plan-digest.ts';

// ---------------------------------------------------------------------------
// inspect.ts — the read-only `.ad` manifest reader. On-design: this IS one
// of the two binding-design entrypoints.
// ---------------------------------------------------------------------------
export { inspectAdReplay } from './internal/inspect.ts';
export type { AdReplayManifest } from './internal/inspect.ts';

// ---------------------------------------------------------------------------
// step-loop.ts — the `.ad` step loop. On-design: this IS the other binding-
// design entrypoint; `AdReplayStepRuntime` is the runtime capability bag the
// daemon adapter (`session-replay-runtime.ts`) implements to thread it.
// ---------------------------------------------------------------------------
export { formatReplaySuccessMessage, runAdReplay } from './internal/step-loop.ts';
export type { AdReplayStepRuntime } from './internal/step-loop.ts';

// ---------------------------------------------------------------------------
// target-identity.ts — record/replay local-identity primitives (ADR 0012
// decision 3).
// façade-deviation: the record-time writer (`src/daemon/session-target-evidence.ts`)
// and replay-time classification core (`session-replay-target-classification.ts`)
// call these identity functions directly so both sides compute the SAME
// ordinal by construction; `wait`'s landmark poll
// (`src/commands/interaction/runtime/selector-wait.ts`) and the shared
// replay-zone tree helpers (`src/replay/target-evidence-tree.ts`,
// `src/replay/target-identity-node.ts`) also call in below `runAdReplay`.
// ---------------------------------------------------------------------------
export {
  annotationLocalIdentity,
  classifyTargetBindingMatch,
  firstAncestryMismatch,
  identityFieldMismatches,
  matchesAncestryPrefix,
  matchesLocalIdentity,
} from './internal/target-identity.ts';
export type { LocalIdentity } from './internal/target-identity.ts';

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
// session-replay-report-action.ts / session-replay-suggestion-ranking.ts —
// the divergence-report action shape and repair-suggestion ranking.
// façade-deviation: `session-replay-maestro-failure.ts`, `session-replay-heal.ts`,
// and `session-replay-divergence.ts` build/rank divergence reports directly;
// none of this rides back through `runAdReplay`'s return value.
// ---------------------------------------------------------------------------
export type { ReplayReportAction } from './internal/session-replay-report-action.ts';
export { rankAndDedupeReplaySuggestions } from './internal/session-replay-suggestion-ranking.ts';

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
