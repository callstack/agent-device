import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildDaemonInstanceMismatchRpcResponse,
  DAEMON_HTTP_INSTANCE_HEADER,
  DAEMON_HTTP_INSTANCE_MISMATCH_HEADER,
} from '@agent-device/contracts/daemon-http';
import type { JsonRpcId } from '@agent-device/kernel/contracts';
import { AppError, normalizeError } from '@agent-device/kernel/errors';

export function refuseStaleDaemonInstance(
  req: IncomingMessage,
  res: ServerResponse,
  rpcId: JsonRpcId,
  instanceId: string,
): boolean {
  const expectedInstanceId = req.headers[DAEMON_HTTP_INSTANCE_HEADER];
  if (
    typeof expectedInstanceId !== 'string' ||
    !expectedInstanceId ||
    expectedInstanceId === instanceId
  ) {
    return false;
  }
  res.statusCode = 409;
  res.setHeader('content-type', 'application/json');
  res.setHeader(DAEMON_HTTP_INSTANCE_MISMATCH_HEADER, 'true');
  res.end(
    JSON.stringify(
      buildDaemonInstanceMismatchRpcResponse(
        rpcId,
        'Daemon instance changed',
        normalizeError(
          new AppError('COMMAND_FAILED', 'Daemon instance changed', {
            reason: 'remote_instance_mismatch',
          }),
        ),
      ),
    ),
  );
  return true;
}
