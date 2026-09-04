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
  readHostDirectory,
  readHostTextFile,
  removeHostPath,
  renameHostPath,
  hostTemporaryDirectory,
  writeHostTextFile,
} from '@agent-device/host-kit/host-file';
import {
  hostProcessId,
  readProcessStartTime,
  signalProcessGroupBestEffort,
} from '@agent-device/host-kit/process';
import { emitDiagnostic, withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import { withKeyedLock } from '@agent-device/kernel/keyed-lock';
import { findProjectRoot } from '@agent-device/host-kit/version';
import { snapshotSourceError } from './errors.ts';
import type { SnapshotSourceHost, SnapshotSourceProcess, SnapshotSourceSocket } from './types.ts';

const BRIDGE_IDLE_TIMEOUT_SECONDS = 60;
const MAX_PROCESS_LOG_BYTES = 64 * 1024;
const SNAPSHOT_SOCKET_ROOT = '/tmp';
const snapshotSourceLocks = new Map<string, Promise<unknown>>();

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
    listDirectory: async (directoryPath) =>
      await readHostDirectory(directoryPath, { withFileTypes: true }),
    ensureDirectory: ensureHostDirectory,
    chmod: chmodHostFile,
    exists: hostFileExistsSync,
    rename: renameHostPath,
    remove: removeHostPath,
    acquireLock: acquireSnapshotSourceLock,
    withKeyedLock: async (key, action) => await withKeyedLock(snapshotSourceLocks, key, action),
    emitDiagnostic,
    withDiagnosticTimer,
    processId: hostProcessId,
    readProcessStartTime,
    temporaryDirectory: hostTemporaryDirectory,
  };
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
  });
}

async function acquireSnapshotSourceLock(lockPath: string): Promise<() => Promise<void>> {
  const pid = hostProcessId();
  return await acquireProcessLock({
    lockDirPath: lockPath,
    owner: {
      pid,
      startTime: readProcessStartTime(pid),
      acquiredAtMs: Date.now(),
    },
    timeoutMs: 180_000,
    pollMs: 100,
    ownerGraceMs: 5_000,
    description: 'iOS Simulator snapshot bridge cache',
  });
}

function appendBoundedLog(current: string, addition: string): string {
  const combined = current + addition;
  return combined.length <= MAX_PROCESS_LOG_BYTES
    ? combined
    : combined.slice(combined.length - MAX_PROCESS_LOG_BYTES);
}

export function snapshotSourceSocketPath(host: SnapshotSourceHost, udid: string): string {
  const targetKey = createHash('sha256').update(udid).digest('hex').slice(0, 12);
  return path.join(
    SNAPSHOT_SOCKET_ROOT,
    `agent-device-ax-${targetKey}-${host.processId()}`,
    'snapshot.sock',
  );
}
