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
  return await runBatch(req, sessionName, async (stepRequest, context) => {
    const step = stepRequest as DaemonRequest;
    // ADR 0016: a batch delivers no script versions from its steps, so a step that closes an armed
    // remote recording would lose the final script. The normalized steps are checked before the
    // first one runs.
    if (
      armedRemoteRecording &&
      context.stepNumber === 1 &&
      [step, ...context.remainingSteps].some((planned) => planned.command === 'close')
    ) {
      throw new AppError('INVALID_ARGS', 'A batch cannot close a remote script recording.', {
        reason: 'remote_script_batch_close_unsupported',
        hint: 'Run close on its own after the batch, so the final script reaches the --save-script file.',
      });
    }
    return await invoke({
      ...step,
      internal: {
        ...step.internal,
        webSession: req.internal?.webSession,
        ...(req.internal?.publicNetworkOnly ? { publicNetworkOnly: true } : {}),
        ...(req.internal?.sessionOmitted ? { sessionOmitted: true } : {}),
        executionPlan: { remainingSteps: context.remainingSteps },
      },
    });
  });
}
