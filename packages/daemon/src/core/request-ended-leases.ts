import type { EndedLease } from '@agent-device/contracts/client';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from './daemon-request.ts';

/** The session leases one request ended, its nested requests' included. */
export type EndedLeaseLedger = EndedLease[];

/** Records a lease `req` ended on the ledger of the outermost request it runs under. */
export function recordEndedLease(req: DaemonRequest, leaseId: string): void {
  req.internal?.endedLeases?.push({ leaseId, outcome: 'released' });
}

/**
 * Runs `handle` for an outermost request on a ledger of its own and reports the leases it ended on
 * its reply. A nested request already carries its delegating request's ledger and reports nothing.
 */
export async function reportEndedLeases(
  req: DaemonRequest,
  handle: (req: DaemonRequest) => Promise<DaemonResponse>,
): Promise<DaemonResponse> {
  if (req.internal?.endedLeases) return await handle(req);
  const endedLeases: EndedLeaseLedger = [];
  const response = await handle({ ...req, internal: { ...req.internal, endedLeases } });
  if (endedLeases.length === 0) return response;
  if (response.ok) return { ok: true, data: { ...response.data, endedLeases } };
  return {
    ok: false,
    error: { ...response.error, details: { ...response.error.details, endedLeases } },
  };
}

/** `req` recording its ended leases on the ledger of `parent`, the request that delegated it. */
export function onDelegatingLedger(req: DaemonRequest, parent: DaemonRequest): DaemonRequest {
  const endedLeases = parent.internal?.endedLeases;
  return endedLeases ? { ...req, internal: { ...req.internal, endedLeases } } : req;
}

/** Each nested request `invoke` runs records its ended leases on the ledger of `parent`. */
export function handDownEndedLeases(invoke: DaemonInvokeFn, parent: DaemonRequest): DaemonInvokeFn {
  return async (req) => await invoke(onDelegatingLedger(req, parent));
}
