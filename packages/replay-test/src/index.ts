/**
 * The replay-test package façade (#1478 P3).
 *
 * One function plus the values crossing its seam. Everything else — scheduling, retries,
 * sharding distribution, attempt identity, timeout policy, finalization/cleanup ordering, and
 * result aggregation — is private to `internal/`.
 *
 * The scheduler is format-agnostic: it imports neither engine, and a source reaches it only as
 * a `ReplayTestManifest`. Host authority arrives as narrow capabilities on
 * `ReplayTestRuntimeDependencies`; none of them hands over a daemon request, a session store,
 * mutable session state, or an engine.
 */
export { runReplayTestSuite } from './internal/session-test.ts';

export type {
  ReplayTestAttemptError,
  ReplayTestAttemptFailed,
  ReplayTestAttemptOutcome,
  ReplayTestAttemptPassed,
  ReplayTestAttemptStep,
  ReplayTestAttemptStepSink,
  ReplayTestBindAttemptCancellation,
  ReplayTestAttemptCancellation,
  ReplayTestCleanupSession,
  ReplayTestDiscoverSources,
  ReplayTestEmitDiagnostic,
  ReplayTestEmitProgress,
  ReplayTestExecutionDependencies,
  ReplayTestFinalizeAttempt,
  ReplayTestIsCanceled,
  ReplayTestManifest,
  ReplayTestPlatform,
  ReplayTestRunReplay,
  ReplayTestRunReplayParams,
  ReplayTestRuntimeDependencies,
  ReplayTestSource,
  ReplayTestSuiteOutcome,
  ReplayTestSuiteRequest,
  ReplayTestTarget,
} from './internal/session-test-types.ts';

export type {
  ReplayTestResolveShardTargets,
  ReplayTestShardContext,
  ReplayTestShardMode,
  ReplayTestShardTarget,
} from './internal/session-test-sharding.ts';
