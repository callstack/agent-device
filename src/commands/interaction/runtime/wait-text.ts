import type {
  SelectorWaitOperations,
  SelectorWaitRuntime,
  WaitCommandContext,
  WaitCommandOptions,
  WaitCommandResult,
} from './selector-wait.ts';
import { findNodeByLabel } from './selector-read-utils.ts';
import { SELECTOR_PIPELINE_POLICIES } from '@agent-device/selectors/selector-pipeline-policy';
import { createWaitPolling, type WaitPollDeadline, waitTimeoutError } from './wait-polling.ts';

export async function waitForText<Runtime extends SelectorWaitRuntime>(
  operations: SelectorWaitOperations<Runtime>,
  runtime: Runtime,
  options: WaitCommandOptions,
  text: string,
  timeoutMs: number | null | undefined,
): Promise<Extract<WaitCommandResult, { kind: 'text' }>> {
  const polling = createWaitPolling(runtime, options, timeoutMs, SELECTOR_PIPELINE_POLICIES.wait);
  let deadline: WaitPollDeadline | undefined;
  while (polling.hasTimeRemaining()) {
    const poll = await polling.capture(
      async (signal) => await observeText(operations, runtime, { ...options, signal }, text),
    );
    if (poll.timedOut) {
      deadline = poll.deadline;
      break;
    }
    const found = poll.value;
    if (found) return { kind: 'text', text, waitedMs: polling.waitedMs() };
    await polling.sleepUntilNextPoll();
  }
  throw waitTimeoutError(`wait timed out for text: ${text}`, polling, deadline);
}

async function observeText<Runtime extends SelectorWaitRuntime>(
  operations: SelectorWaitOperations<Runtime>,
  runtime: Runtime,
  options: WaitCommandOptions,
  text: string,
): Promise<boolean> {
  if (runtime.backend.findText) {
    const native = await runtime.backend.findText(backendContext(runtime, options), text);
    if (native.found) return true;
  }
  return await snapshotContainsText(operations, runtime, options, text);
}

async function snapshotContainsText<Runtime extends SelectorWaitRuntime>(
  operations: SelectorWaitOperations<Runtime>,
  runtime: Runtime,
  options: WaitCommandOptions,
  text: string,
): Promise<boolean> {
  // Presence-only poll: skip scroll-hint derivation (#1270), same as waitForFindMatch.
  const capture = await operations.captureSnapshot(runtime, options, {
    updateSession: true,
    includeHiddenContentHints: false,
  });
  return Boolean(findNodeByLabel(capture.snapshot.nodes, text));
}

function backendContext(
  runtime: SelectorWaitRuntime,
  options: WaitCommandContext,
): WaitCommandContext {
  return {
    session: options.session,
    requestId: options.requestId,
    signal: options.signal ?? runtime.signal,
    metadata: options.metadata,
  };
}
