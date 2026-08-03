/**
 * The `ad-replay` package façade (#1478 P5 stage D — narrowed; report-action/
 * suggestion-ranking/vars/identity-vocabulary further narrowed by the P5
 * review pass; plan-digest/resume and `classifyTargetBindingMatch` further
 * narrowed by the #1555 review pass, "complete the binding façade instead of
 * documenting deviations"; the target-verification policy functions further
 * narrowed by the #1555 review's R3 pass, "target verification must happen
 * INSIDE the engine"; every type export dropped and `formatReplaySuccessMessage`
 * moved daemon-side by the #1555 review's second pass, "enforce the accepted
 * two-entrypoint facade"). `scripts/layering/package-boundaries.test.ts`
 * asserts this file's exact export list — see "the real tree parses,
 * declares, and passes R11" — so a stray export (including one this parser
 * cannot enumerate a name for, like `export *`) fails that gate, not just a
 * comment mismatch.
 *
 * The binding design (issue comment 5156017698) is `inspectAdReplay` +
 * `runAdReplay` and NOTHING else — no types, no third value. Every type this
 * package's signatures reference is available to a root consumer by deriving
 * it structurally off these two functions (`Parameters<...>`,
 * `ReturnType<...>`, `Awaited<...>`) — `src/daemon/ad-replay-facade-types.ts`
 * is the one root module that does this derivation, so it happens exactly
 * once; every other root file imports the derived names from there instead
 * of re-deriving them or reaching for a named façade export. Presentation
 * (`formatReplaySuccessMessage`) is not engine policy either, so it moved to
 * sit beside its one caller (`completeReplayRun`,
 * `src/daemon/handlers/session-replay-runtime.ts`).
 *
 * `inspectAdReplay` is the read-only `.ad` manifest reader — the plan-digest
 * hash (`plan-digest.ts`, `computeReplayPlanDigest`) and the `--from`/
 * `--plan-digest` resume-point math (`resume.ts`, `resolveReplayEntryIndex`)
 * are internal-only; the manifest carries the digest as `planDigest` and the
 * resume math as a `resolveEntryIndex` closure instead, so
 * `session-replay-runtime-plan.ts`'s `prepareReplayPlan` and
 * `request-router-repair-expired.test.ts` read them off the manifest rather
 * than importing the underlying functions.
 *
 * `runAdReplay` is the `.ad` step loop; `AdReplayStepRuntime` (derived, not
 * exported) is the runtime capability bag the daemon adapter
 * (`session-replay-runtime-engine-adapter.ts`) implements to thread it,
 * including the `ReplaySelectorPort` instance (`AdReplayStepRuntime['port']`)
 * every daemon call site that threads a port value names by the SAME derived
 * type. Two adapters implement the port: the production adapter
 * (`src/daemon/replay-selector-port.ts`) and the in-memory adapter for this
 * package's own contract suite (`src/__tests__/test-utils/in-memory-replay-selector-port.ts`
 * — relocated there, #1478 P5 stage D, because package-internal code may not
 * "reach back into root `src/`", R11, once its only remaining consumer was a
 * root test).
 *
 * `./target-verification.ts`'s four policy functions
 * (`planPostResolutionTargetVerification`, `planPreDispatchTargetVerification`,
 * `deriveReplayTargetGuardMismatchEvidence`, `deriveWaitLandmarkMismatchEvidence`)
 * are called only from `./internal/step-loop.ts`'s `verifyAndDispatchStep` —
 * the engine's own verify-then-dispatch orchestration, which drives the
 * daemon-owned pieces (capture, classification, dispatch, wire-building)
 * through the narrow `AdReplayStepRuntime` capabilities instead of the
 * daemon calling the policy functions directly — so nothing from that module
 * is exported here.
 *
 * `${VAR}` scope/planning: the engine builds the `${VAR}` scope (via
 * `@agent-device/ad-script`) from the request's `varSources` and resolves
 * each action exactly once per step, handing the daemon's `dispatchStep`/
 * `beginTargetVerification` capabilities the RESOLVED action — never a raw
 * action plus a scope for the daemon to interpolate itself (#1555 review P1,
 * "move variable semantics/planning behind the replay entrypoint"). The
 * `${VAR}`-scrub values a divergence report redacts are threaded the same
 * direction, as an explicit argument on each build*Failure/handleActionFailure
 * capability, computed from the engine's own live scope — never recomputed
 * daemon-side from a second scope object.
 */

export { inspectAdReplay } from './internal/inspect.ts';

export { runAdReplay } from './internal/step-loop.ts';
