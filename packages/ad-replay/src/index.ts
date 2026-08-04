/**
 * The `ad-replay` package façade (#1478 P5 stage D — narrowed; report-action/
 * suggestion-ranking/vars/identity-vocabulary further narrowed by the P5
 * review pass; plan-digest/resume and `classifyTargetBindingMatch` further
 * narrowed by the #1555 review pass, "complete the binding façade instead of
 * documenting deviations"; the target-verification policy functions further
 * narrowed by the #1555 review's R3 pass, "target verification must happen
 * INSIDE the engine"). `scripts/layering/package-boundaries.test.ts` asserts
 * this file's exact export list — see "the real tree parses, declares, and
 * passes R11" — so a stray export (including one this parser cannot
 * enumerate a name for, like `export *`) fails that gate, not just a comment
 * mismatch.
 *
 * The binding design (issue comment 5156017698) is two value entrypoints —
 * `inspectAdReplay` + `runAdReplay` — plus the neutral vocabulary their
 * signatures are built from, exported by name (#1555 structural-quality
 * review, "typed façade replaces the zero-type rule"): a package a root
 * consumer must integrate against through hand-derived `Parameters<...>`/
 * `ReturnType<...>` gymnastics in a SINGLE allowed root module
 * (`src/daemon/ad-replay-facade-types.ts`, since deleted) is a shim tax, not
 * an isolation win — every derived name still had to be re-exported from that
 * one file for every other root module to use, and every daemon-side type
 * that shadowed an engine type by hand (`TargetVerificationEntry`,
 * `TargetClassificationOutcome`, `TargetBindingFailureEvidence`,
 * `ReplayVerifiedTargetGuard`, plus a `toDaemonEvidence` copy translator
 * between mutable and readonly array shapes) was a duplicate definition that
 * could silently drift from the type it mirrored. `packages/maestro`'s
 * façade (`facade-execution.ts`/`facade-runtime-port.ts`/…) is the precedent:
 * a package boundary is enforced by an exact, gate-pinned export LIST, not by
 * exporting zero types. The gate below now pins values AND types together,
 * so a stray widening — a type accidentally exported, or one accidentally
 * dropped that a root file was still deriving by hand — fails loudly either
 * way.
 *
 * `inspectAdReplay` is the read-only `.ad` manifest reader — the plan-digest
 * hash (`plan-digest.ts`, `computeReplayPlanDigest`) and the `--from`/
 * `--plan-digest` resume-point math (`resume.ts`, `resolveReplayEntryIndex`)
 * are internal-only; the manifest carries the digest as `planDigest` and the
 * resume math as a `resolveEntryIndex` closure instead, so
 * `session-replay-runtime-plan.ts`'s `prepareReplayPlan` and
 * `request-router-repair-expired.test.ts` read them off the manifest rather
 * than importing the underlying functions. `AdReplayManifest` is its return
 * type and `AdReplayVarSources` is `runAdReplay`'s `${VAR}` scope-input
 * shape — both named here since `session-replay-runtime-plan.ts` threads them
 * by name across its own helper signatures.
 *
 * `runAdReplay` is the `.ad` step loop; `AdReplayStepRuntime` is the runtime
 * capability bag the daemon adapter
 * (`session-replay-runtime-engine-adapter.ts`) implements to thread it,
 * including the `ReplaySelectorPort` instance every daemon call site that
 * threads a port value names by the SAME type. Two adapters implement the
 * port: the production adapter (`src/daemon/replay-selector-port.ts`) and
 * the in-memory adapter for this package's own contract suite
 * (`src/__tests__/test-utils/in-memory-replay-selector-port.ts` — relocated
 * there, #1478 P5 stage D, because package-internal code may not "reach back
 * into root `src/`", R11, once its only remaining consumer was a root test).
 *
 * `./internal/target-verification.ts`'s four policy functions
 * (`planPostResolutionTargetVerification`, `planPreDispatchTargetVerification`,
 * `deriveReplayTargetGuardMismatchEvidence`, `deriveWaitLandmarkMismatchEvidence`)
 * stay engine-private — they are called only from `./internal/verify-dispatch.ts`'s
 * `verifyAndDispatchStep`, never the daemon — but the TYPED evidence shapes
 * they consume (`AdReplayGuardMismatchEvidence`, `AdReplayLandmarkMismatchEvidence`)
 * and the classification/guard/binding-evidence/verification-routing shapes
 * `verifyAndDispatchStep` exchanges with the daemon's `AdReplayStepRuntime`
 * implementation (`AdReplayVerificationEntry`, `AdReplayTargetClassification`,
 * `AdReplayTargetBindingEvidence`, `AdReplayDispatchGuard`,
 * `AdReplayDispatchOutcome`) ARE named here: the
 * daemon builds/reads real values of these shapes directly now (routing in
 * `session-replay-target-verification.ts`, wire-narrowing in
 * `session-replay-runtime-engine-adapter.ts`) rather than re-declaring a
 * structurally-identical twin per module.
 *
 * `${VAR}` scope/planning: the engine builds the `${VAR}` scope (via
 * `@agent-device/ad-script`) from the request's `varSources` and resolves
 * each action exactly once per step, handing the daemon's `dispatchStep`/
 * `beginTargetVerification` capabilities the RESOLVED action — never a raw
 * action plus a scope for the daemon to interpolate itself (#1555 review P1,
 * "move variable semantics/planning behind the replay entrypoint"). The
 * `${VAR}`-scrub values a divergence report redacts (`AdReplayScrubValue`)
 * are threaded the same direction, as an explicit argument on each
 * build*Failure/handleActionFailure capability, computed ONCE per run from
 * the engine's own live scope — never recomputed daemon-side from a second
 * scope object, and never re-collected per call site.
 */

export { inspectAdReplay } from './internal/inspect.ts';
export type { AdReplayManifest } from './internal/inspect.ts';

export { runAdReplay } from './internal/step-loop.ts';

export type {
  AdReplayDispatchGuard,
  AdReplayDispatchOutcome,
  AdReplayScrubValue,
  AdReplayStepFailure,
  AdReplayStepRuntime,
  AdReplayTargetBindingEvidence,
  AdReplayTargetClassification,
  AdReplayVarSources,
  AdReplayVerificationEntry,
} from './internal/runtime-port-types.ts';

export type {
  AdReplayGuardMismatchEvidence,
  AdReplayLandmarkMismatchEvidence,
} from './internal/target-verification.ts';

export type {
  ReplayRecordedTargetDisambiguation,
  ReplayRecordedTargetPolicy,
  ReplayRecordedTargetResolution,
  ReplaySelectorCandidateOptions,
  ReplaySelectorExpressionOutcome,
  ReplaySelectorGrammar,
  ReplaySelectorPort,
} from './internal/selector-port.ts';
