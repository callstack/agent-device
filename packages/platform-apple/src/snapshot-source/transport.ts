import { asSnapshotSourceError, snapshotSourceError } from './errors.ts';
import { remainingSnapshotSourceMs, type SnapshotSourceDeadline } from './deadline.ts';
import { bridgeProcessExited } from './process.ts';
import {
  acceptSnapshotBridgeEnvelope,
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

type BridgeExitWatcher = Readonly<{ onExit: () => void; onError: (error: unknown) => void }>;

const bridgeExitWatchers = new WeakMap<SnapshotSourceProcess, Set<BridgeExitWatcher>>();

/**
 * Tells `watcher` when the bridge process exits or its exit status cannot be read, and returns the
 * call that stops watching.
 *
 * `bridgeProcess.wait` stays pending for the bridge's whole life, and a reaction on a pending promise
 * cannot be removed. A reaction per round trip would keep each round trip's decoder, request frame and
 * response envelope reachable until the bridge exits, so the process carries one reaction and a round
 * trip only joins and leaves the set it notifies.
 */
function watchBridgeExit(
  bridgeProcess: SnapshotSourceProcess,
  watcher: BridgeExitWatcher,
): () => void {
  const watchers = bridgeExitWatchers.get(bridgeProcess) ?? startBridgeExitWatch(bridgeProcess);
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

function startBridgeExitWatch(bridgeProcess: SnapshotSourceProcess): Set<BridgeExitWatcher> {
  const watchers = new Set<BridgeExitWatcher>();
  bridgeExitWatchers.set(bridgeProcess, watchers);
  // The entry goes once the status settles, so a round trip that starts after the exit registers on
  // the settled promise and still hears about the exit on its next turn.
  bridgeProcess.wait.then(
    () => {
      bridgeExitWatchers.delete(bridgeProcess);
      for (const watcher of watchers) watcher.onExit();
    },
    (error: unknown) => {
      bridgeExitWatchers.delete(bridgeProcess);
      for (const watcher of watchers) watcher.onError(error);
    },
  );
  return watchers;
}

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
    let bridgeRequestSent = false;
    const timer = setTimeout(() => {
      finishReject(
        snapshotSourceError('timeout', 'bridge-request-deadline', { bridgeRequestSent }),
      );
      input.socket.destroy();
    }, timeoutMs);
    const onAbort = () => {
      finishReject(snapshotSourceError('cancelled', 'abort-signal', { bridgeRequestSent }));
      input.socket.destroy();
    };
    const onData = (chunk: unknown) => {
      try {
        if (!Buffer.isBuffer(chunk))
          throw snapshotSourceError('transport-failure', 'bridge-data-invalid');
        const body = decoder.push(chunk);
        if (body) {
          const envelope = acceptSnapshotBridgeEnvelope(parseSnapshotBridgeEnvelope(body), {
            requestId: input.requestId,
            pid: input.expectedPid,
            generation: input.expectedGeneration,
          });
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
    const stopWatchingExit = watchBridgeExit(input.process, {
      onExit: () => {
        void bridgeProcessExited(input.host, input.process).then(finishReject);
      },
      onError,
    });
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
      stopWatchingExit();
      action();
    };

    input.socket.on('data', onData);
    input.socket.on('error', onError);
    input.socket.on('close', onClose);
    input.deadline.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (input.deadline.signal?.aborted) throw snapshotSourceError('cancelled', 'abort-signal');
      bridgeRequestSent = true;
      input.socket.write(input.frame);
    } catch (error) {
      finishReject(asSnapshotSourceError(error));
      input.socket.destroy();
    }
  });
}
