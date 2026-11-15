import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import { runBatch } from '@agent-device/command-registry/batch';
import type { DaemonInvokeFn, DaemonRequest } from '../../core/daemon-request.ts';

export async function runBatchCommands(
  req: DaemonRequest,
  sessionName: string,
  invoke: DaemonInvokeFn,
  armedRemoteRecording = false,
): Promise<DaemonResponse> {
  if (armedRemoteRecording) assertBatchKeepsRemoteRecording(req);
  return await runBatch(req, sessionName, async (stepRequest, context) => {
    const step = stepRequest as DaemonRequest;
    return await invoke({
      ...step,
      internal: {
        ...step.internal,
        webSession: req.internal?.webSession,
        ...(req.internal?.publicNetworkOnly ? { publicNetworkOnly: true } : {}),
        executionPlan: { remainingSteps: context.remainingSteps },
      },
    });
  });
}

/**
 * ADR 0016: a batch delivers no script versions from its steps, so a step that closes an armed
 * remote recording would lose the final script. It is refused before any step runs.
 */
function assertBatchKeepsRemoteRecording(req: DaemonRequest): void {
  if (!(req.flags?.batchSteps ?? []).some((step) => step.command === 'close')) return;
  throw new AppError('INVALID_ARGS', 'A batch cannot close a remote script recording.', {
    reason: 'remote_script_batch_close_unsupported',
    hint: 'Run close on its own after the batch, so the final script reaches the --save-script file.',
  });
}
