import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { auditResultRefs } from '@agent-device/contracts/capture';
import { dispatchSnapshotRuntimeCommand } from './snapshot-command-runtime.ts';
import type { SnapshotRuntimeRouteParams } from '../core/snapshot-runtime-binding.ts';
import { markSessionPartialRefsIssued } from '../execution/session-snapshot.ts';

/**
 * Canonical `audit` route: one fresh capture over the request-bound capture runtime. The response
 * returns only its finding and screen-reader order refs, so it is a partial publication (ADR 0014):
 * the refs are issued through the partial-frame primitive and ride with the frame epoch. A response
 * without refs issues nothing and leaves the frame as it was.
 */
export async function dispatchSnapshotAuditViaRuntime(
  params: SnapshotRuntimeRouteParams,
): Promise<DaemonResponse> {
  return await dispatchSnapshotRuntimeCommand({
    ...params,
    command: 'audit',
    execute: async ({ runtime: agentRuntime, sessionName, device, getSession }) => {
      const result = await agentRuntime.capture.auditSnapshot({
        session: sessionName,
        target: device.target,
      });
      const session = getSession();
      const refs = auditResultRefs(result);
      if (!session || refs.length === 0) return { data: result };
      markSessionPartialRefsIssued(session, refs);
      const refsGeneration = session.snapshotGeneration;
      return { data: refsGeneration === undefined ? result : { ...result, refsGeneration } };
    },
  });
}
