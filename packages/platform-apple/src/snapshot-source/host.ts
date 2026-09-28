import { createHash } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { runCmd, runCmdBackground } from '@agent-device/host-kit/command';
import { hostHomeDirectory } from '@agent-device/host-kit/host-file';
import { signalProcessGroupBestEffort } from '@agent-device/host-kit/process';
import { emitDiagnostic, withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import { findProjectRoot } from '@agent-device/host-kit/version';
import { createNativeBuildHost } from '../native-build/host.ts';
import { snapshotSourceError } from './errors.ts';
import type { SnapshotSourceHost, SnapshotSourceProcess, SnapshotSourceSocket } from './types.ts';
import { readSnapshotTargetProcessStartTime } from '../snapshot-process.ts';
import { buildSimctlArgsForAddress, type SimulatorAddress } from '../core/simctl.ts';

const BRIDGE_IDLE_TIMEOUT_SECONDS = 60;
const MAX_PROCESS_LOG_BYTES = 64 * 1024;
const SNAPSHOT_SOCKET_ROOT = '/tmp';

export function createSnapshotSourceHost(): SnapshotSourceHost {
  // The bridge's build/cache access is the shared native-build host (#2970); this adds only what a
  // bridge session needs beyond a build: socket start/connect, diagnostics, and target inspection.
  // A native-build cache failure surfaces here as `NativeBuildError`; the cache's own callers
  // (`snapshot-source/cache.ts`) map it onto `SnapshotSourceError`, so this host does not.
  return {
    ...createNativeBuildHost(
      async (command, args, options) => await runCmd(command, args, options),
    ),
    projectRoot: findProjectRoot,
    homeDirectory: hostHomeDirectory,
    start: startSnapshotBridge,
    connect: connectSnapshotBridge,
    emitDiagnostic,
    withDiagnosticTimer,
    readTargetProcessStartTime: readSnapshotTargetProcessStartTime,
  };
}

function startSnapshotBridge(
  simulator: SimulatorAddress,
  bridgePath: string,
  socketPath: string,
  options: { signal?: AbortSignal } = {},
): SnapshotSourceProcess {
  if (options.signal?.aborted) {
    throw snapshotSourceError('cancelled', 'abort-signal');
  }
  const started = runCmdBackground(
    'xcrun',
    buildSimctlArgsForAddress(simulator, [
      'spawn',
      simulator.udid,
      bridgePath,
      'serve',
      socketPath,
      '--idle-timeout',
      String(BRIDGE_IDLE_TIMEOUT_SECONDS),
      '--exit-on-disconnect',
      'false',
    ]),
    {
      allowFailure: true,
      captureOutput: false,
      detached: true,
    },
  );
  const pid = started.child.pid ?? 0;
  if (pid <= 0) {
    throw snapshotSourceError('transport-failure', 'bridge-process-pid-missing');
  }

  let log = '';
  started.child.stderr?.setEncoding('utf8');
  started.child.stderr?.on('data', (chunk: string | Buffer) => {
    log = appendBoundedLog(log, String(chunk));
  });

  return {
    pid,
    wait: started.wait,
    isAlive: () => started.child.exitCode === null && started.child.signalCode === null,
    signal: (signal) => {
      if (!signalProcessGroupBestEffort(pid, signal)) {
        started.child.kill(signal);
      }
    },
    readLog: () => log,
  };
}

async function connectSnapshotBridge(
  socketPath: string,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<SnapshotSourceSocket> {
  if (options.signal?.aborted) {
    throw snapshotSourceError('cancelled', 'abort-signal');
  }
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
  return await new Promise<SnapshotSourceSocket>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let connected = false;
    let settled = false;
    const timer = setTimeout(() => {
      finish(snapshotSourceError('timeout', 'bridge-connect-timeout'));
      socket.destroy();
    }, timeoutMs);
    const onAbort = () => {
      finish(snapshotSourceError('cancelled', 'abort-signal'));
      socket.destroy();
    };
    const onConnect = () => {
      connected = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.setTimeout(0);
      resolve(socket);
    };
    const onError = (error: Error) => {
      finish(error);
      socket.destroy();
    };
    const onClose = () => {
      if (!connected)
        finish(snapshotSourceError('transport-failure', 'bridge-closed-before-connect'));
    };
    const finish = (error: unknown) => {
      if (settled || connected) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      socket.off('connect', onConnect);
      socket.off('error', onError);
      socket.off('close', onClose);
      reject(error);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
    socket.once('close', onClose);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

function appendBoundedLog(current: string, addition: string): string {
  const combined = current + addition;
  return combined.length <= MAX_PROCESS_LOG_BYTES
    ? combined
    : combined.slice(combined.length - MAX_PROCESS_LOG_BYTES);
}

export function snapshotSourceSocketPath(
  host: SnapshotSourceHost,
  udid: string,
  ownerId: string,
): string {
  const targetKey = createHash('sha256').update(udid).digest('hex').slice(0, 12);
  const ownerKey = createHash('sha256').update(ownerId).digest('hex').slice(0, 12);
  return path.join(
    SNAPSHOT_SOCKET_ROOT,
    `agent-device-ax-${targetKey}-${host.processId()}-${ownerKey}`,
    'snapshot.sock',
  );
}
