import { type BatchInvoke, runBatch } from '../../core/batch.ts';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from '../daemon-request.ts';

export async function runBatchCommands(
  req: DaemonRequest,
  sessionName: string,
  invoke: DaemonInvokeFn,
): Promise<DaemonResponse> {
  return await runBatch(req, sessionName, invoke as BatchInvoke);
}
