import { createHash } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { runCmd, runCmdBackground } from '@agent-device/host-kit/command';
import { acquireProcessLock } from '@agent-device/host-kit/file';
import {
  chmodHostFile,
  ensureHostDirectory,
  hostFileExistsSync,
  hostHomeDirectory,
  readHostBinaryFile,
  readHostTextFile,
  removeHostPath,
  renameHostPath,
  writeHostTextFile,
} from '@agent-device/host-kit/host-file';
import {
  hostProcessId,
  readProcessStartTime,
  signalProcessGroupBestEffort,
} from '@agent-device/host-kit/process';
import { emitDiagnostic, withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import { findProjectRoot } from '@agent-device/host-kit/version';
import { SnapshotSourceError, snapshotSourceError } from './errors.ts';
import { remainingSnapshotSourceMs } from './deadline.ts';
import type { SnapshotSourceHost, SnapshotSourceProcess, SnapshotSourceSocket } from './types.ts';

const BRIDGE_IDLE_TIMEOUT_SECONDS = 60;
const MAX_PROCESS_LOG_BYTES = 64 * 1024;
const SNAPSHOT_SOCKET_ROOT = '/tmp';

export function createSnapshotSourceHost(): SnapshotSourceHost {
  return {
    projectRoot: findProjectRoot,
    homeDirectory: hostHomeDirectory,
    run: async (command, args, options) => await runCmd(command, args, options),
    start: startSnapshotBridge,
    connect: connectSnapshotBridge,
    readText: readHostTextFile,
    readBinary: readHostBinaryFile,
    writeText: writeHostTextFile,
    ensureDirectory: ensureHostDirectory,
    chmod: chmodHostFile,
    exists: hostFileExistsSync,
    rename: renameHostPath,
    remove: removeHostPath,
    acquireLock: acquireSnapshotSourceLock,
    emitDiagnostic,
    withDiagnosticTimer,
    processId: hostProcessId,
    readTargetProcessStartTime,
  };
}

async function readTargetProcessStartTime(
  pid: number,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<string | null> {
  const result = await runCmd('ps', ['-p', String(pid), '-o', 'lstart='], {
    allowFailure: true,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

function startSnapshotBridge(
  udid: string,
  bridgePath: string,
  socketPath: string,
  options: { signal?: AbortSignal } = {},
): SnapshotSourceProcess {
  if (options.signal?.aborted) {
    throw snapshotSourceError('cancelled', 'abort-signal');
  }
  const started = runCmdBackground(
    'xcrun',
    [
      'simctl',
      'spawn',
      udid,
      bridgePath,
      'serve',
      socketPath,
      '--idle-timeout',
      String(BRIDGE_IDLE_TIMEOUT_SECONDS),
      '--exit-on-disconnect',
      'false',
    ],
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

async function acquireSnapshotSourceLock(
  lockPath: string,
  options: Parameters<SnapshotSourceHost['acquireLock']>[1],
): Promise<() => Promise<void>> {
  const pid = hostProcessId();
  const deadline = options.deadline;
  const pending = acquireProcessLock({
    lockDirPath: lockPath,
    owner: {
      pid,
      startTime: readProcessStartTime(pid),
      acquiredAtMs: Date.now(),
    },
    timeoutMs: remainingSnapshotSourceMs(deadline, 'cache-lock-deadline'),
    pollMs: 100,
    ownerGraceMs: 5_000,
    description: 'iOS Simulator snapshot bridge cache',
  });
  const signal = deadline.signal;
  if (!signal) return await pending;

  let canceled = false;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      canceled = true;
      reject(snapshotSourceError('cancelled', 'abort-signal'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([pending, aborted]);
  } catch (error) {
    if (canceled)
      void pending.then(
        (release) => release(),
        () => undefined,
      );
    if (
      deadline.clock.isExpired() &&
      !(error instanceof SnapshotSourceError && error.failureKind === 'cancelled')
    ) {
      throw snapshotSourceError('timeout', 'cache-lock-deadline');
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
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
