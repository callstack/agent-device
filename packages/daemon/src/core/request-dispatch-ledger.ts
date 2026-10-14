import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from './daemon-request.ts';
import { RUNTIME_OPERATION_EFFECTS } from './runtime-operation-effects.ts';

/**
 * The device-reaching mutations one request sent whose send returned, its nested requests'
 * included. Once one did, no later failure of that request may claim `dispatched: no`.
 */
export type RequestDispatchLedger = { dispatchedSteps: number };

export function createRequestDispatchLedger(): RequestDispatchLedger {
  return { dispatchedSteps: 0 };
}

/** The ledger a request records into: the one its delegating request handed down, or its own. */
export function requestDispatchLedger(req: DaemonRequest): RequestDispatchLedger {
  return req.internal?.dispatchLedger ?? createRequestDispatchLedger();
}

type RuntimeOperation = (...args: never[]) => unknown;

/** The same bound runtime, whose every `mutates` operation records its returned send in `ledger`. */
export function recordBoundMutations<Bound extends Readonly<{ operations: object }>>(
  bound: Bound,
  ledger: RequestDispatchLedger,
): Bound {
  const operations: Record<string, unknown> = {};
  for (const [name, operation] of Object.entries(bound.operations)) {
    operations[name] =
      typeof operation === 'function' &&
      RUNTIME_OPERATION_EFFECTS[name as keyof typeof RUNTIME_OPERATION_EFFECTS] === 'mutates'
        ? recordingMutation(operation as RuntimeOperation, ledger)
        : operation;
  }
  return Object.freeze({ ...bound, operations: Object.freeze(operations) });
}

function recordingMutation(
  operation: RuntimeOperation,
  ledger: RequestDispatchLedger,
): RuntimeOperation {
  return (...args) => {
    const result = operation(...args);
    if (!(result instanceof Promise)) {
      ledger.dispatchedSteps += 1;
      return result;
    }
    return result.then((value: unknown) => {
      ledger.dispatchedSteps += 1;
      return value;
    });
  };
}

/**
 * Runs each nested request (a batch step, a replay action, a find's delegated action) on a ledger
 * of its own, then moves its sends into `ledger`. A failed nested response keeps only the steps its
 * producer counted inside a failing send, so the parent that adds its ledger counts each send once.
 */
export function recordNestedRequests(
  invoke: DaemonInvokeFn,
  ledger: RequestDispatchLedger,
): DaemonInvokeFn {
  return async (req) => {
    const nested = createRequestDispatchLedger();
    const response = await invoke({
      ...req,
      internal: { ...req.internal, dispatchLedger: nested },
    });
    ledger.dispatchedSteps += nested.dispatchedSteps;
    if (response.ok || nested.dispatchedSteps === 0) return response;
    return withoutLedgerSteps(response, nested.dispatchedSteps);
  };
}

function withoutLedgerSteps(
  response: Extract<DaemonResponse, { ok: false }>,
  ledgerSteps: number,
): DaemonResponse {
  const { dispatchedSteps, ...details } = response.error.details ?? {};
  const producerSteps = typeof dispatchedSteps === 'number' ? dispatchedSteps - ledgerSteps : 0;
  return {
    ...response,
    error: {
      ...response.error,
      details: producerSteps > 0 ? { ...details, dispatchedSteps: producerSteps } : details,
    },
  };
}
