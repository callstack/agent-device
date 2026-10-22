import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { runCmdStreaming } from '@agent-device/host-kit/command';
import {
  publishFileSync,
  inspectProcessLock,
  tryAcquireProcessLock,
  type ProcessLockRelease,
} from '@agent-device/host-kit/file';
import {
  isProcessGroupAlive,
  readCurrentOwnerIdentity,
  readProcessStartTime,
  ownerIdentityDiffers,
  signalProcessGroupBestEffort,
} from '@agent-device/host-kit/process';

export const VALIDATION_PARENT_ENV = 'AGENT_DEVICE_VALIDATION_PARENT';
const COMMAND_RUNNER = path.join(import.meta.dirname, 'command.ts');
const HOST_LOCK_PATH = path.join(os.homedir(), '.cache', 'agent-device', 'validation.lock');

export type ValidationLock = {
  release: ProcessLockRelease;
  recordCommand: (receipt: string, pid: number | null) => void;
  finishCommand: (pid: number | undefined) => Promise<void>;
};

export async function acquireValidationLock(
  signal: AbortSignal,
  lockDirPath = HOST_LOCK_PATH,
  report: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ValidationLock> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error(
      'Serialized validation requires macOS or Linux. Use plan mode or focused checks on this host.',
    );
  }
  if (env[VALIDATION_PARENT_ENV]) {
    throw new Error(
      `Nested validation is not allowed. Parent receipt: ${env[VALIDATION_PARENT_ENV]}`,
    );
  }
  const owner = { ...readCurrentOwnerIdentity(), acquiredAtMs: Date.now() };
  const deadline = Date.now() + 2 * 60 * 60 * 1000;
  let nextReport = 0;
  while (true) {
    signal.throwIfAborted();
    const activePath = `${lockDirPath}.active.json`;
    const orphan = readOrphanCommand(lockDirPath);
    const attempt = orphan
      ? { status: 'busy' as const, inspection: { orphan } }
      : tryAcquireProcessLock({ lockDirPath, owner, description: 'host validation' });
    if (attempt.status === 'acquired') {
      fs.rmSync(activePath, { force: true });
      return {
        release: attempt.acquisition.release,
        recordCommand: (receipt, pid) => recordValidationCommand(lockDirPath, receipt, pid),
        finishCommand: (pid) => finishValidationCommand(lockDirPath, pid),
      };
    }
    if (Date.now() >= deadline)
      throw new Error(`Host validation wait exceeded 2 hours: ${lockDirPath}`);
    if (Date.now() >= nextReport) {
      report(
        `[wait] ${orphan ? 'orphan validation group' : 'host validation'}: ${JSON.stringify(attempt.inspection)}; Ctrl-C cancels this waiter`,
      );
      nextReport = Date.now() + 15_000;
    }
    await setTimeout(500, undefined, { signal });
  }
}

// Owns the order orphan reclaim depends on: publish ownership, activate the command, then finish.
export async function runLockedCommand(
  lock: ValidationLock,
  receipt: string,
  command: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    onStdoutChunk: (chunk: string) => void;
    onStderrChunk: (chunk: string) => void;
  },
): Promise<number> {
  const [executable, ...args] = command as [string, ...string[]];
  let commandPid: number | undefined;
  try {
    lock.recordCommand(receipt, null);
    const output = await runCmdStreaming(
      process.execPath,
      ['--experimental-strip-types', COMMAND_RUNNER, executable, ...args],
      {
        cwd: options.cwd,
        allowFailure: true,
        captureOutput: false,
        detached: true,
        kill: { signal: 'SIGTERM', graceMs: 5000 },
        signal: options.signal,
        stdin: 'run\n',
        onSpawn: (child) => {
          commandPid = child.pid;
          if (commandPid) lock.recordCommand(receipt, commandPid);
        },
        env: { ...options.env, [VALIDATION_PARENT_ENV]: receipt },
        onStdoutChunk: options.onStdoutChunk,
        onStderrChunk: options.onStderrChunk,
      },
    );
    return output.exitCode;
  } finally {
    await lock.finishCommand(commandPid);
  }
}

function recordValidationCommand(lockDirPath: string, receipt: string, pid: number | null): void {
  publishFileSync({
    destination: `${lockDirPath}.active.json`,
    contents: JSON.stringify({
      receipt,
      pid,
      startTime: pid === null ? null : readProcessStartTime(pid),
      activation: 'stdin',
    }),
  });
}

async function finishValidationCommand(
  lockDirPath: string,
  pid: number | undefined,
): Promise<void> {
  readActiveCommand(`${lockDirPath}.active.json`);
  if (pid !== undefined) await waitForCommandExit(lockDirPath, pid);
  readActiveCommand(`${lockDirPath}.active.json`);
  fs.rmSync(`${lockDirPath}.active.json`, { force: true });
}

async function waitForCommandExit(lockDirPath: string, pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (isProcessGroupAlive(pid)) {
    if (Date.now() >= deadline)
      throw new Error(
        `Validation command group ${pid} has not exited; host validation remains blocked.`,
      );
    if (Date.now() >= deadline - 5000) signalProcessGroupBestEffort(pid, 'SIGKILL');
    await setTimeout(100);
  }
}

function readOrphanCommand(lockDirPath: string): { pid: number; receipt: string } | null {
  const activePath = `${lockDirPath}.active.json`;
  const inspection = inspectProcessLock(lockDirPath);
  if (
    inspection.state === 'held' &&
    (inspection.liveness === 'live' || inspection.liveness === 'unknown')
  )
    return null;
  const active = readActiveCommand(activePath);
  if (!active) return null;
  const current = inspectProcessLock(lockDirPath);
  if (current.state === 'held' && (current.liveness === 'live' || current.liveness === 'unknown'))
    return null;
  if (active.pid === null) return null;
  const observed = { pid: active.pid, startTime: readProcessStartTime(active.pid) };
  if (ownerIdentityDiffers({ pid: active.pid, startTime: active.startTime }, observed)) return null;
  return isProcessGroupAlive(active.pid) ? { pid: active.pid, receipt: active.receipt } : null;
}

function readActiveCommand(
  activePath: string,
): { pid: number | null; startTime: string | null; receipt: string } | null {
  let contents: string;
  try {
    contents = fs.readFileSync(activePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const active = JSON.parse(contents) as {
    pid: number | null;
    startTime: string | null;
    receipt: string;
    activation: string;
  };
  if (
    active.activation !== 'stdin' ||
    (active.pid !== null && (!Number.isInteger(active.pid) || active.pid <= 0))
  ) {
    throw new Error(`Cannot verify validation command ownership: ${activePath}`);
  }
  return active;
}
