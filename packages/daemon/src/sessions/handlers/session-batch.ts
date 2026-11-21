import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { runBatch } from '@agent-device/command-registry/batch';
import { collectBatchStepDelivery } from '../../core/request-script-delivery-ledger.ts';
import type { DaemonInvokeFn, DaemonRequest } from '../../core/daemon-request.ts';
import { resolveLeaseScope } from '../../core/lease-context.ts';

export async function runBatchCommands(
  req: DaemonRequest,
  sessionName: string,
  invoke: DaemonInvokeFn,
): Promise<DaemonResponse> {
  return await runBatch(req, sessionName, async (stepRequest, context) => {
    const step = stepRequest as DaemonRequest;
    const response = await invoke({
      ...step,
      meta: withoutFlaggedLeaseMeta(step),
      internal: {
        ...step.internal,
        webSession: req.internal?.webSession,
        ...(req.internal?.publicNetworkOnly ? { publicNetworkOnly: true } : {}),
        ...(req.internal?.scriptDelivery ? { scriptDelivery: req.internal.scriptDelivery } : {}),
        ...(req.internal?.sessionOmitted ? { sessionOmitted: true } : {}),
        executionPlan: { remainingSteps: context.remainingSteps },
      },
    });
    // ADR 0016 (#4595): the outer request owns the batch's script-delivery receipt, so each executed
    // step hands its delivery effects to that ledger instead of the client reading step results.
    collectBatchStepDelivery(req, { number: context.stepNumber, command: step.command }, response);
    return response;
  });
}

/**
 * A step inherits the batch's meta, and a lease field in meta wins over the same field in flags. A
 * step's flags carry its own lease fields over the batch's, so a lease field in the step's flags
 * drops the inherited meta value: a step that names another lease id is refused.
 */
function withoutFlaggedLeaseMeta(step: DaemonRequest): DaemonRequest['meta'] {
  if (!step.meta) return step.meta;
  // The tenant stays in meta: the HTTP intake may have attested it. Admission compares a step's
  // flag tenant with the lease of a leased session.
  const flagged = Object.keys(resolveLeaseScope({ flags: step.flags })).filter(
    (key) => key !== 'tenantId',
  );
  if (flagged.length === 0) return step.meta;
  const meta: Record<string, unknown> = { ...step.meta };
  for (const key of flagged) delete meta[key];
  return meta as DaemonRequest['meta'];
}
