import { AppError } from '@agent-device/kernel/errors';
import { WAIT_REASONS } from '@agent-device/contracts/wait';
import type {
  SelectorWaitOperations,
  SelectorWaitRuntime,
  WaitCommandOptions,
  WaitCommandResult,
} from './selector-wait.ts';
import { DEFAULT_WAIT_TIMEOUT_MS } from './wait-polling.ts';

export async function waitForStable<Runtime extends SelectorWaitRuntime>(
  operations: SelectorWaitOperations<Runtime>,
  runtime: Runtime,
  options: WaitCommandOptions,
  quietMs: number | null | undefined,
  timeoutMs: number | null | undefined,
): Promise<Extract<WaitCommandResult, { kind: 'stable' }>> {
  const timeout = timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const quiet = quietMs ?? operations.stable.defaultQuietMs;
  const outcome = await operations.stable.capture(runtime, options, {
    quietMs: quiet,
    timeoutMs: timeout,
  });
  if (!outcome.settled) {
    throw new AppError('COMMAND_FAILED', 'wait timed out waiting for a stable UI', {
      reason: WAIT_REASONS.stableTimeout,
      ...(outcome.stalled ? { captureStalled: true } : {}),
      quietMs: quiet,
      timeoutMs: timeout,
      captures: outcome.captures,
      nodeCount: outcome.nodeCount,
      ...(outcome.stalled
        ? {
            hint: 'A snapshot capture stalled past the wait timeout, so no settle verdict is available. The UI may still be readable: retry, or use screenshot to inspect the surface.',
          }
        : {}),
    });
  }
  return {
    kind: 'stable',
    waitedMs: outcome.waitedMs,
    captures: outcome.captures,
    nodeCount: outcome.nodeCount,
    ...(outcome.nodeCount < operations.stable.tinyTreeNodeCount
      ? { hint: operations.stable.tinyTreeHint }
      : {}),
  };
}
