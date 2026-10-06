import type { ExecOptions, ExecResult } from '@agent-device/host-kit/command';
import { acquireProcessLock } from '@agent-device/host-kit/file';
import {
  chmodHostFile,
  ensureHostDirectory,
  hostFileExistsSync,
  readHostBinaryFile,
  readHostTextFile,
  removeHostPath,
  renameHostPath,
  writeHostTextFile,
} from '@agent-device/host-kit/host-file';
import {
  hostProcessId,
  readHostCpuArch,
  readProcessStartTime,
} from '@agent-device/host-kit/process';
import { NativeBuildError, nativeBuildError } from './errors.ts';
import { remainingNativeBuildMs, type NativeBuildDeadline } from './deadline.ts';

/**
 * The file access, command execution, lock acquisition, and process identity a native build/cache
 * needs, and nothing a consumer's own protocol requires: no bridge socket start/connect, no
 * target-process inspection (#2970).
 */
export type NativeBuildHost = Readonly<{
  run(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  readText(path: string): Promise<string>;
  readBinary(path: string): Promise<Buffer>;
  writeText(path: string, contents: string): Promise<void>;
  ensureDirectory(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  exists(path: string): boolean;
  rename(sourcePath: string, destinationPath: string): Promise<void>;
  remove(path: string): Promise<void>;
  acquireLock(
    path: string,
    /** Names the contended resource in a stall's diagnostic; every lock holder states its own. */
    options: { deadline: NativeBuildDeadline; description: string },
  ): Promise<() => Promise<void>>;
  processId(): number;
  cpuArch(): Promise<string>;
}>;

export function createNativeBuildHost(run: NativeBuildHost['run']): NativeBuildHost {
  return {
    run,
    readText: readHostTextFile,
    readBinary: readHostBinaryFile,
    writeText: writeHostTextFile,
    ensureDirectory: ensureHostDirectory,
    chmod: chmodHostFile,
    exists: hostFileExistsSync,
    rename: renameHostPath,
    remove: removeHostPath,
    acquireLock: acquireNativeBuildLock,
    processId: hostProcessId,
    cpuArch: readHostCpuArch,
  };
}

async function acquireNativeBuildLock(
  lockPath: string,
  options: { deadline: NativeBuildDeadline; description: string },
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
    timeoutMs: remainingNativeBuildMs(deadline, 'cache-lock-deadline'),
    pollMs: 100,
    description: options.description,
  });
  const signal = deadline.signal;
  if (!signal) {
    try {
      return await pending;
    } catch (error) {
      throw mapExpiredLockError(error, deadline);
    }
  }

  let canceled = false;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      canceled = true;
      reject(nativeBuildError('cancelled', 'abort-signal'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([pending, aborted]);
  } catch (error) {
    if (canceled) {
      // The task is abandoned, so its lock is released best effort. A release that cannot prove
      // ownership leaves the lock to the stale-clear path, which is the outcome this branch
      // already accepts; it must not arrive as an unhandled rejection on a promise nobody is
      // awaiting any more.
      void pending.then(
        (release) => release().catch(() => undefined),
        () => undefined,
      );
    }
    throw mapExpiredLockError(error, deadline);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** A lock wait that outlives the native-build deadline reports the deadline, not the raw lock error. */
function mapExpiredLockError(error: unknown, deadline: NativeBuildDeadline): unknown {
  if (
    deadline.clock.isExpired() &&
    !(error instanceof NativeBuildError && error.buildFailureKind === 'cancelled')
  ) {
    return nativeBuildError('timeout', 'cache-lock-deadline');
  }
  return error;
}
