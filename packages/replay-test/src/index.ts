/**
 * The replay-test package façade (#1478 P3).
 *
 * One function plus the values crossing its seam. Everything else — scheduling, retries,
 * sharding distribution, attempt identity, timeout policy, finalization/cleanup ordering, and
 * result aggregation — is private to `internal/`.
 *
 * The scheduler is format-agnostic: it imports neither engine, and a source reaches it only as
 * a `ReplayTestManifest`. Host authority arrives as narrow capabilities on the runtime-dependency
 * half of `runReplayTestSuite`'s parameter; none of them hands over a daemon request, a session
 * store, mutable session state, or an engine.
 *
 * The parameter and result types themselves are not named here. The single caller builds the
 * bag inline and TypeScript infers both, so re-exporting the names would add surface no consumer
 * asks for; a consumer that needs to name one earns it back through the R11 pin.
 */
export { runReplayTestSuite } from './internal/session-test.ts';

export type {
  ReplayTestAttemptFailed,
  ReplayTestAttemptOutcome,
  ReplayTestAttemptStepSink,
  ReplayTestBindAttemptCancellation,
  ReplayTestDiscoverSources,
  ReplayTestManifest,
  ReplayTestSource,
  ReplayTestSuiteRequest,
} from './internal/session-test-types.ts';

export type {
  ReplayTestResolveShardTargets,
  ReplayTestShardContext,
  ReplayTestShardMode,
  ReplayTestShardTarget,
} from './internal/session-test-sharding.ts';
