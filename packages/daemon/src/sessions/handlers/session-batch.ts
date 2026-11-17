import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { runBatch } from '@agent-device/command-registry/batch';
import { collectBatchStepDelivery } from '../../core/request-script-delivery-ledger.ts';
import type { DaemonInvokeFn, DaemonRequest } from '../../core/daemon-request.ts';

export async function runBatchCommands(
  req: DaemonRequest,
  sessionName: string,
  invoke: DaemonInvokeFn,
): Promise<DaemonResponse> {
  return await runBatch(req, sessionName, async (stepRequest, context) => {
    const step = stepRequest as DaemonRequest;
    const response = await invoke({
      ...step,
      internal: {
        ...step.internal,
        webSession: req.internal?.webSession,
        ...(req.internal?.publicNetworkOnly ? { publicNetworkOnly: true } : {}),
        ...(req.internal?.scriptDelivery ? { scriptDelivery: req.internal.scriptDelivery } : {}),
        executionPlan: { remainingSteps: context.remainingSteps },
      },
    });
    // ADR 0016 (#4595): the outer request owns the batch's script-delivery receipt, so each executed
    // step hands its delivery effects to that ledger instead of the client reading step results.
    collectBatchStepDelivery(req, { number: context.stepNumber, command: step.command }, response);
    return response;
  });
}
