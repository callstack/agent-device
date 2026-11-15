import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import {
  runBatch,
  validateAndNormalizeBatchSteps,
  type NormalizedBatchStep,
} from '@agent-device/command-registry/batch';
import { DEFAULT_BATCH_MAX_STEPS } from '@agent-device/contracts/command';
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
  let steps: NormalizedBatchStep[];
  try {
    // The steps as the batch runs them, so a spelling such as ` CLOSE ` cannot slip past.
    steps = validateAndNormalizeBatchSteps(
      req.flags?.batchSteps,
      req.flags?.batchMaxSteps ?? DEFAULT_BATCH_MAX_STEPS,
    );
  } catch {
    return; // Malformed steps get the batch's own refusal from runBatch.
  }
  if (!steps.some((step) => step.command === 'close')) return;
  throw new AppError('INVALID_ARGS', 'A batch cannot close a remote script recording.', {
    reason: 'remote_script_batch_close_unsupported',
    hint: 'Run close on its own after the batch, so the final script reaches the --save-script file.',
  });
}
