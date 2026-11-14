/** The managed backend identity that owns native replay and suite execution. */
export const NATIVE_REPLAY_BACKEND = 'ad';

import type {
  AdReplayDigestFlags,
  AdReplayManifest,
  AdReplayRunRequest,
  AdReplayRunOutcome,
  AdReplayStepRuntime,
} from './ad-replay-execution.ts';
import type {
  ReplayTestSuiteRequest,
  ReplayTestSuiteOutcome,
  ReplayTestRuntimeDependencies,
} from './replay-test-execution.ts';

/** Native execution receives host-owned inspection, step and suite inputs. */
export type ReplayExecution = Readonly<{
  inspectAdReplay(script: string, digestFlags?: AdReplayDigestFlags): AdReplayManifest;
  runAdReplay(
    request: AdReplayRunRequest,
    runtime: AdReplayStepRuntime,
  ): Promise<AdReplayRunOutcome>;
  runReplayTestSuite(
    params: { request: ReplayTestSuiteRequest } & ReplayTestRuntimeDependencies,
  ): Promise<ReplayTestSuiteOutcome>;
}>;

/** The managed registry creates one native engine and owns its lifetime. */
export type ReplayExecutionPlugin = Readonly<{
  create(): ReplayExecution | Promise<ReplayExecution>;
}>;

export type ReplayExecutionResolver = (packageName?: string) => Promise<ReplayExecution>;
