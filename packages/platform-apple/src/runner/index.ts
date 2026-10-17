/**
 * @agent-device/platform-apple/runner - the Apple XCUITest runner client.
 *
 * The façade exports the host-free surface only: provider seam coordination,
 * pure sequence builders, and types. Host-bound operations (command execution,
 * prewarm/prepare, session lifecycle, leases) are reached through the package
 * composition root, which binds the real host capabilities exactly once, so
 * façade consumers never evaluate the implementation.
 */

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
export { resolveRunnerContainerBundleIds } from './runner-cache-metadata.ts';
