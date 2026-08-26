/**
 * @agent-device/platform-apple/runner - the Apple XCUITest runner client.
 *
 * The façade exports the host-free surface only: the client factory, provider
 * seam coordination, pure sequence builders, and types. Host-bound operations
 * (command execution, prewarm/prepare, session lifecycle, leases) exist only
 * on the {@link AppleRunnerClient} returned by {@link createAppleRunnerClient},
 * which the root composition module constructs exactly once with the real host
 * capabilities.
 */

// The client factory lives behind the './client' subpath so façade consumers
// (types, pure helpers, runner bundle ids) never evaluate the implementation.
export type { AppleRunnerHost } from './host.ts';
export type { RunnerCommand } from './runner-contract.ts';
export {
  withAppleRunnerProvider,
  type AppleRunnerCommandExecutor,
  type AppleRunnerCommandOptions,
  type AppleRunnerLifecycleOptions,
  type AppleRunnerPrepareResult,
  type AppleRunnerProvider,
} from './runner-provider.ts';
export { buildRunnerSequenceCommand, parseRunnerSequenceResult } from './runner-sequence.ts';
export { IOS_RUNNER_CONTAINER_BUNDLE_IDS } from './runner-cache-metadata.ts';
