import {
  emitDiagnostic,
  isProcessAlive,
  isProcessGroupAlive,
  signalPidsBestEffort,
  signalProcessGroupBestEffort,
  type ExecBackgroundResult,
  buildSimctlArgsForDevice,
  runAppleToolCommand,
  runXcrun,
} from './host.ts';
import { isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import { cleanupTempFile } from './runner-io.ts';
import { waitForRunner } from './runner-startup-transport.ts';
import { withRunnerCommandId, type RunnerCommand } from './runner-contract.ts';
import {
  cleanupOwnedRunnerLease,
  currentRunnerLeaseOwnerToken,
  releaseRunnerLease,
  withRunnerLeaseLock,
  type RunnerLeaseCleanupAdapter,
} from './runner-lease.ts';
import { IOS_RUNNER_CONTAINER_BUNDLE_IDS, runnerPrepProcesses } from './runner-xctestrun.ts';
import type { RunnerSession } from './runner-session-types.ts';

export const RUNNER_INVALIDATE_WAIT_TIMEOUT_MS = 1_000;

const RUNNER_STOP_WAIT_TIMEOUT_MS = 10_000;
const RUNNER_SHUTDOWN_TIMEOUT_MS = 15_000;
const MACOS_RUNNER_INTERRUPT_WAIT_TIMEOUT_MS = 5_000;
const MACOS_RUNNER_TERM_WAIT_TIMEOUT_MS = 2_000;
const RUNNER_STALE_XCODEBUILD_KILL_TIMEOUT_MS = 2_000;
const RUNNER_SIMULATOR_TERMINATE_TIMEOUT_MS = 2_000;

export const runnerLeaseCleanupAdapter: RunnerLeaseCleanupAdapter = {
  cleanupRunnerProcessTree: killRunnerProcessTree,
  cleanupRunnerXcodebuildProcesses: killRunnerXcodebuildProcesses,
  cleanupTempFile,
};

export type RunnerDisposalOptions = {
  graceful?: boolean;
  waitTimeoutMs?: number;
  /**
   * The caller already executes inside {@link withRunnerLeaseLock} for this
   * device, so the ownership-fenced device-wide teardown must not re-acquire
   * the (non-reentrant) lease lock.
   */
  leaseLockHeld?: boolean;
};

export async function disposeRunnerSession(
  session: RunnerSession,
  options: RunnerDisposalOptions = {},
): Promise<void> {
  let processExitHandled = false;
  if (options.graceful !== false) {
    processExitHandled = await shutdownRunnerSessionGracefully(session);
  } else if (isMacOs(session.device)) {
    await interruptMacOsRunnerSessions([session]);
    await cleanupRunnerSessionResources(session, options);
    return;
  } else {
    await killRunnerProcessTree(session.child.pid, 'SIGTERM');
  }

  if (!processExitHandled) {
    await waitForRunnerProcessExit(session, options.waitTimeoutMs ?? RUNNER_STOP_WAIT_TIMEOUT_MS);
    if (isRunnerProcessTreeAlive(session.child.pid)) {
      await killRunnerProcessTree(session.child.pid, 'SIGKILL');
    }
  }
  await cleanupRunnerSessionResources(session, options);
}

export async function cleanupOwnedIosRunnerLease(deviceId: string): Promise<void> {
  await cleanupOwnedRunnerLease(deviceId, runnerLeaseCleanupAdapter);
}

export async function abortRunnerSessionsAndPrepProcesses(
  activeSessions: readonly RunnerSession[],
): Promise<void> {
  const prepProcesses = Array.from(runnerPrepProcesses);
  const macOsSessions = activeSessions.filter((session) => isMacOs(session.device));
  const otherSessions = activeSessions.filter((session) => !isMacOs(session.device));
  await signalRunnerSessions(otherSessions, 'SIGINT');
  await signalRunnerPrepProcesses(prepProcesses, 'SIGINT');
  await signalRunnerSessions(otherSessions, 'SIGTERM');
  await signalRunnerPrepProcesses(prepProcesses, 'SIGTERM');
  await signalRunnerSessions(otherSessions, 'SIGKILL');
  await signalRunnerPrepProcesses(prepProcesses, 'SIGKILL');
  await interruptMacOsRunnerSessions(macOsSessions);
  await Promise.allSettled(
    activeSessions.map(async (session) => {
      await cleanupRunnerSessionResources(session);
    }),
  );
}

export async function stopRunnerPrepProcesses(): Promise<void> {
  const prepProcesses = Array.from(runnerPrepProcesses);
  await Promise.allSettled(
    prepProcesses.map(async (child) => {
      try {
        await killRunnerProcessTree(child.pid, 'SIGTERM');
        await killRunnerProcessTree(child.pid, 'SIGKILL');
      } finally {
        runnerPrepProcesses.delete(child);
      }
    }),
  );
}

async function shutdownRunnerSessionGracefully(session: RunnerSession): Promise<boolean> {
  try {
    await waitForRunner(
      session.device,
      session.port,
      withRunnerCommandId({
        command: 'shutdown',
      } as RunnerCommand),
      undefined,
      RUNNER_SHUTDOWN_TIMEOUT_MS,
    );
    return false;
  } catch {
    if (isMacOs(session.device)) {
      await interruptMacOsRunnerSessions([session]);
      return true;
    } else {
      await killRunnerProcessTree(session.child.pid, 'SIGTERM');
      return false;
    }
  }
}

async function waitForRunnerProcessExit(
  session: RunnerSession,
  waitTimeoutMs: number,
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    const exited = await Promise.race([
      session.testPromise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), waitTimeoutMs);
      }),
    ]);
    return exited || !isRunnerProcessTreeAlive(session.child.pid);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function interruptMacOsRunnerSessions(sessions: readonly RunnerSession[]): Promise<void> {
  if (sessions.length === 0) return;

  // CONSERVATIVE: XCTest disables the host screen saver while macOS UI automation runs and
  // restores it during xcodebuild teardown. Give SIGINT time to complete that teardown before
  // escalating; revisit only if XCTest exposes a separate public cleanup acknowledgement.
  await signalRunnerSessions(sessions, 'SIGINT');
  const afterInterrupt = await runnerSessionsStillAlive(
    sessions,
    MACOS_RUNNER_INTERRUPT_WAIT_TIMEOUT_MS,
  );
  await signalRunnerSessions(afterInterrupt, 'SIGTERM');
  const afterTerm = await runnerSessionsStillAlive(
    afterInterrupt,
    MACOS_RUNNER_TERM_WAIT_TIMEOUT_MS,
  );
  await signalRunnerSessions(afterTerm, 'SIGKILL');
}

async function runnerSessionsStillAlive(
  sessions: readonly RunnerSession[],
  waitTimeoutMs: number,
): Promise<RunnerSession[]> {
  const exited = await Promise.all(
    sessions.map(async (session) => await waitForRunnerProcessExit(session, waitTimeoutMs)),
  );
  return sessions.filter((_, index) => !exited[index]);
}

async function cleanupRunnerSessionResources(
  session: RunnerSession,
  options: Pick<RunnerDisposalOptions, 'leaseLockHeld'> = {},
): Promise<void> {
  await settleOwnedRunnerDeviceState(session, options);
  cleanupTempFile(session.xctestrunPath);
  cleanupTempFile(session.jsonPath);
  await session.simulatorSetRedirect?.release();
}

/**
 * Terminating the runner container bundles acts on the whole device, and the
 * lease file names whose runner lives in them; a takeover (device-claim or
 * logical-lease) can change that between a check and the termination. The
 * ownership check, the termination, and the lease release therefore run as one
 * operation under the runner-lease lock — the same lock a successor holds for
 * its entire reclaim-and-publish window. If the lock cannot be acquired, all
 * device-wide teardown is skipped: whoever owns the lease settles that state,
 * and an unreleased own lease turns stale once this process exits.
 */
async function settleOwnedRunnerDeviceState(
  session: RunnerSession,
  options: Pick<RunnerDisposalOptions, 'leaseLockHeld'>,
): Promise<void> {
  const settle = async () => {
    if (runnerLeaseOwnedElsewhere(session)) return;
    try {
      await terminateRunnerSimulatorApps(session.device);
    } finally {
      releaseRunnerLease(session.lease);
    }
  };
  if (options.leaseLockHeld) {
    await settle();
    return;
  }
  try {
    await withRunnerLeaseLock(session.deviceId, settle);
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'ios_runner_disposal_lease_lock_unavailable',
      data: {
        deviceId: session.deviceId,
        sessionId: session.sessionId,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function runnerLeaseOwnedElsewhere(session: RunnerSession): boolean {
  const onDiskToken = currentRunnerLeaseOwnerToken(session.deviceId);
  return onDiskToken !== null && onDiskToken !== session.lease?.ownerToken;
}

async function terminateRunnerSimulatorApps(device: DeviceInfo): Promise<void> {
  if (device.kind !== 'simulator') return;

  await Promise.allSettled(
    IOS_RUNNER_CONTAINER_BUNDLE_IDS.map(async (bundleId) => {
      try {
        await runXcrun(buildSimctlArgsForDevice(device, ['terminate', device.id, bundleId]), {
          allowFailure: true,
          timeoutMs: RUNNER_SIMULATOR_TERMINATE_TIMEOUT_MS,
        });
      } catch (error) {
        emitDiagnostic({
          level: 'warn',
          phase: 'ios_runner_simulator_app_terminate_failed',
          data: {
            deviceId: device.id,
            bundleId,
            timeoutMs: RUNNER_SIMULATOR_TERMINATE_TIMEOUT_MS,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }),
  );
}

function isRunnerProcessTreeAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  return isRunnerProcessAlive(pid) || isProcessGroupAlive(pid);
}

export function isRunnerProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  return isProcessAlive(pid);
}

async function signalRunnerSessions(
  activeSessions: readonly RunnerSession[],
  signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL',
): Promise<void> {
  await Promise.allSettled(
    activeSessions.map(async (session) => {
      await killRunnerProcessTree(session.child.pid, signal);
    }),
  );
}

async function signalRunnerPrepProcesses(
  prepProcesses: readonly ExecBackgroundResult['child'][],
  signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL',
): Promise<void> {
  await Promise.allSettled(
    prepProcesses.map(async (child) => {
      await killRunnerProcessTree(child.pid, signal);
      if (signal === 'SIGKILL') {
        runnerPrepProcesses.delete(child);
      }
    }),
  );
}

async function killRunnerProcessTree(
  pid: number | undefined,
  signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL',
): Promise<void> {
  if (!pid || pid <= 0) return;
  signalProcessGroupBestEffort(pid, signal);
  signalPidsBestEffort([pid], signal);
  const pkillSignal = signal === 'SIGINT' ? 'INT' : signal === 'SIGTERM' ? 'TERM' : 'KILL';
  try {
    await runAppleToolCommand('pkill', [`-${pkillSignal}`, '-P', String(pid)], {
      allowFailure: true,
    });
  } catch {}
}

async function killRunnerXcodebuildProcesses(
  deviceId: string,
  ownerToken: string | undefined,
): Promise<void> {
  const pattern = ownerToken
    ? `xcodebuild.*test-without-building.*AgentDeviceRunner\\.env\\.session-${escapeRegex(deviceId)}-${escapeRegex(ownerToken)}-`
    : `xcodebuild.*test-without-building.*AgentDeviceRunner\\.env\\.session-${escapeRegex(deviceId)}-[0-9]`;
  for (const signal of ['TERM', 'KILL'] as const) {
    try {
      await runAppleToolCommand('pkill', [`-${signal}`, '-f', pattern], {
        allowFailure: true,
        timeoutMs: RUNNER_STALE_XCODEBUILD_KILL_TIMEOUT_MS,
      });
    } catch (error) {
      emitDiagnostic({
        level: 'warn',
        phase: 'ios_runner_stale_xcodebuild_kill_failed',
        data: {
          deviceId,
          signal,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
