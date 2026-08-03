import { inspectAdReplay, runAdReplay } from '@agent-device/ad-replay';

/**
 * #1555 review P1 ("enforce the accepted two-entrypoint facade"): `@agent-device/ad-replay`
 * exports exactly two value symbols — `inspectAdReplay` and `runAdReplay` — and no types at all
 * (`packages/ad-replay/src/index.ts`'s header has the full design; `scripts/layering/package-boundaries.test.ts`'s
 * exact-symbol pin is the gate that enforces it). Every type a root daemon file used to import
 * directly off the façade is derived here instead — `Parameters<...>`/`ReturnType<...>`/
 * `Awaited<...>` off those two functions, exactly the idiom `session-replay-runtime-engine-adapter.ts`
 * already used for `ReplayDispatchGuard`/`ReplayDispatchOutcome`/`EngineTargetBindingEvidence` — in
 * exactly ONE place, so the derivation is never duplicated per call site. Every other root consumer
 * imports the names below instead of re-deriving them.
 */

/** `inspectAdReplay`'s read-only `.ad` manifest — actions, header metadata, plan digest, and the `--from`/`--plan-digest` resume-index resolver. */
export type AdReplayManifest = ReturnType<typeof inspectAdReplay>;

/** `runAdReplay`'s injected capability bag — the daemon-implemented runtime the engine's step loop drives through. */
export type AdReplayStepRuntime = Parameters<typeof runAdReplay>[1];

/** A step's neutral failure shape — the resolved type any `AdReplayStepRuntime` build-failure/handle-failure capability returns. */
export type AdReplayStepFailure = Awaited<ReturnType<AdReplayStepRuntime['handleActionFailure']>>;

/**
 * The selector-port instance `AdReplayStepRuntime` threads through classification and the engine's
 * own pre-dispatch verification plan. Two adapters implement it: the production adapter
 * (`replay-selector-port.ts`) and the in-memory adapter for the package's own contract suite
 * (`src/__tests__/test-utils/in-memory-replay-selector-port.ts`).
 */
export type ReplaySelectorPort = AdReplayStepRuntime['port'];

/** Which positional grammar a command's selector-bearing arguments follow (`readSelectorExpression`'s first parameter). */
export type ReplaySelectorGrammar = Parameters<ReplaySelectorPort['readSelectorExpression']>[0];

/** `readSelectorExpression`'s tagged result. */
export type ReplaySelectorExpressionOutcome = ReturnType<
  ReplaySelectorPort['readSelectorExpression']
>;

/** `resolveRecordedTarget`'s resolution policy (platform, rect/disambiguation requirements). */
export type ReplayRecordedTargetPolicy = Parameters<ReplaySelectorPort['resolveRecordedTarget']>[2];

/** `resolveRecordedTarget`'s tagged resolved/unresolved result. */
export type ReplayRecordedTargetResolution = ReturnType<
  ReplaySelectorPort['resolveRecordedTarget']
>;

/** Present on a resolved result only when the heuristic picked among N>1 matches for the winning alternative. */
export type ReplayRecordedTargetDisambiguation = NonNullable<
  Extract<ReplayRecordedTargetResolution, { kind: 'resolved' }>['disambiguation']
>;

/** `buildSelectorCandidates`'s optional options bag. */
export type ReplaySelectorCandidateOptions = NonNullable<
  Parameters<ReplaySelectorPort['buildSelectorCandidates']>[2]
>;
