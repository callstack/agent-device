import { asSnapshotSourceError, snapshotSourceError } from './errors.ts';
import { remainingSnapshotSourceMs, type SnapshotSourceDeadline } from './deadline.ts';
import { bridgeProcessExited } from './process.ts';
import {
  assertSnapshotBridgeEnvelope,
  assertSnapshotBridgeTargetIdentity,
  bridgeFailureFromEnvelope,
  parseSnapshotBridgeEnvelope,
  SnapshotBridgeFrameDecoder,
  type SnapshotBridgeEnvelope,
} from './protocol.ts';
import type {
  SnapshotSourceHost,
  SnapshotSourceLimits,
  SnapshotSourceProcess,
  SnapshotSourceSocket,
} from './types.ts';

export async function roundTripSnapshotBridge(
  input: Readonly<{
    process: SnapshotSourceProcess;
    socket: SnapshotSourceSocket;
    frame: Buffer;
    requestId: string;
    deadline: SnapshotSourceDeadline;
    limits: SnapshotSourceLimits;
    expectedPid: number;
    expectedGeneration: string;
    host: SnapshotSourceHost;
  }>,
): Promise<SnapshotBridgeEnvelope> {
  const decoder = new SnapshotBridgeFrameDecoder(input.limits.maxResponseBytes - 4);
  const timeoutMs = remainingSnapshotSourceMs(input.deadline, 'bridge-request-deadline');
  return await new Promise<SnapshotBridgeEnvelope>((resolve, reject) => {
    let settled = false;
    let dispatched = false;
    const timer = setTimeout(() => {
      finishReject(snapshotSourceError('timeout', 'bridge-request-deadline', { dispatched }));
      input.socket.destroy();
    }, timeoutMs);
    const onAbort = () => {
      finishReject(snapshotSourceError('cancelled', 'abort-signal', { dispatched }));
      input.socket.destroy();
    };
    const onData = (chunk: unknown) => {
      try {
        if (!Buffer.isBuffer(chunk))
          throw snapshotSourceError('transport-failure', 'bridge-data-invalid');
        const body = decoder.push(chunk);
        if (body) {
          const envelope = parseSnapshotBridgeEnvelope(body);
          assertSnapshotBridgeEnvelope(envelope, input.requestId);
          assertSnapshotBridgeTargetIdentity(envelope, {
            pid: input.expectedPid,
            generation: input.expectedGeneration,
          });
          if (envelope.ok !== true) bridgeFailureFromEnvelope(envelope);
          if (typeof envelope.truncated !== 'boolean') {
            throw snapshotSourceError('malformed-tree', 'truncated-invalid');
          }
          finishResolve(envelope);
          return;
        }
      } catch (error) {
        finishReject(error);
        input.socket.destroy();
      }
    };
    const onError = (error: unknown) => finishReject(asSnapshotSourceError(error));
    const onClose = () => {
      if (!settled) {
        if (input.process.isAlive()) {
          finishReject(snapshotSourceError('transport-failure', 'bridge-connection-closed'));
        } else {
          void bridgeProcessExited(input.host, input.process).then(finishReject);
        }
      }
    };
    input.process.wait.then(
      () => {
        if (!settled) void bridgeProcessExited(input.host, input.process).then(finishReject);
      },
      (error: unknown) => {
        if (!settled) finishReject(asSnapshotSourceError(error));
      },
    );
    const finishResolve = (value: SnapshotBridgeEnvelope) => finish(() => resolve(value));
    const finishReject = (error: unknown) => finish(() => reject(error));
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.deadline.signal?.removeEventListener('abort', onAbort);
      input.socket.off('data', onData);
      input.socket.off('error', onError);
      input.socket.off('close', onClose);
      action();
    };

    input.socket.on('data', onData);
    input.socket.on('error', onError);
    input.socket.on('close', onClose);
    input.deadline.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (input.deadline.signal?.aborted) throw snapshotSourceError('cancelled', 'abort-signal');
      dispatched = true;
      input.socket.write(input.frame);
    } catch (error) {
      finishReject(asSnapshotSourceError(error));
      input.socket.destroy();
    }
  });
}
