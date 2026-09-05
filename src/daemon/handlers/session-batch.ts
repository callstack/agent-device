import { runBatch } from '../../core/batch.ts';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from '../types.ts';

export async function runBatchCommands(
  req: DaemonRequest,
  sessionName: string,
  invoke: DaemonInvokeFn,
): Promise<DaemonResponse> {
  return await runBatch(req, sessionName, async (stepRequest, context) => {
    const step = stepRequest as DaemonRequest;
    return await invoke({
      ...step,
      internal: {
        ...step.internal,
        executionPlan: { remainingSteps: context.remainingSteps },
      },
    });
  });
}
