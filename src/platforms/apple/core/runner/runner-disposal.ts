import { emitDiagnostic } from '../../../../utils/diagnostics.ts';
import type { DeviceInfo } from '../../../../kernel/device.ts';
import { isProcessAlive, isProcessGroupAlive } from '../../../../utils/process-identity.ts';
import { cleanupTempFile, waitForRunner } from './runner-transport.ts';
import { withRunnerCommandId, type RunnerCommand } from './runner-contract.ts';
import {
  cleanupOwnedRunnerLease,
  releaseRunnerLease,
  type RunnerLeaseCleanupAdapter,
} from './runner-lease.ts';
import { IOS_RUNNER_CONTAINER_BUNDLE_IDS, runnerPrepProcesses } from './runner-xctestrun.ts';
import { buildSimctlArgsForDevice } from '../simctl.ts';
import { runAppleToolCommand, runXcrun } from '../tool-provider.ts';
import type { RunnerSession } from './runner-session-types.ts';

export const RUNNER_INVALIDATE_WAIT_TIMEOUT_MS = 1_000;

const RUNNER_STOP_WAIT_TIMEOUT_MS = 10_000;
const RUNNER_SHUTDOWN_TIMEOUT_MS = 15_000;
const RUNNER_STALE_XCODEBUILD_KILL_TIMEOUT_MS = 2_000;
const RUNNER_SIMULATOR_TERMINATE_TIMEOUT_MS = 2_000;

export const runnerLeaseCleanupAdapter: RunnerLeaseCleanupAdapter = {
  cleanupRunnerProcessTree: killRunnerProcessTree,
  cleanupRunnerXcodebuildProcesses: killRunnerXcodebuildProcesses,
  cleanupTempFile,
};

export async function disposeRunnerSession(
  session: RunnerSession,
  options: { graceful?: boolean; waitTimeoutMs?: number } = {},
): Promise<void> {
  if (options.graceful !== false) {
    await shutdownRunnerSessionGracefully(session);
  } else {
    await killRunnerProcessTree(session.child.pid, 'SIGTERM');
  }

  await waitForRunnerProcessExit(session, options.waitTimeoutMs ?? RUNNER_STOP_WAIT_TIMEOUT_MS);
  if (isRunnerProcessTreeAlive(session.child.pid)) {
    await killRunnerProcessTree(session.child.pid, 'SIGKILL');
  }
  await cleanupRunnerSessionResources(session);
}

export async function cleanupOwnedIosRunnerLease(deviceId: string): Promise<void> {
  await cleanupOwnedRunnerLease(deviceId, runnerLeaseCleanupAdapter);
}

export async function abortRunnerSessionsAndPrepProcesses(
  activeSessions: readonly RunnerSession[],
): Promise<void> {
  const prepProcesses = Array.from(runnerPrepProcesses);
  await signalRunnerSessions(activeSessions, 'SIGINT');
  await signalRunnerPrepProcesses(prepProcesses, 'SIGINT');
  await signalRunnerSessions(activeSessions, 'SIGTERM');
  await signalRunnerPrepProcesses(prepProcesses, 'SIGTERM');
  await signalRunnerSessions(activeSessions, 'SIGKILL');
  await signalRunnerPrepProcesses(prepProcesses, 'SIGKILL');
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

async function shutdownRunnerSessionGracefully(session: RunnerSession): Promise<void> {
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
  } catch {
    await killRunnerProcessTree(session.child.pid, 'SIGTERM');
  }
}

async function waitForRunnerProcessExit(
  session: RunnerSession,
  waitTimeoutMs: number,
): Promise<void> {
  try {
    await Promise.race([
      session.testPromise,
      new Promise<void>((resolve) => setTimeout(resolve, waitTimeoutMs)),
    ]);
  } catch {}
}

async function cleanupRunnerSessionResources(session: RunnerSession): Promise<void> {
  await terminateRunnerSimulatorApps(session.device);
  cleanupTempFile(session.xctestrunPath);
  cleanupTempFile(session.jsonPath);
  try {
    await session.simulatorSetRedirect?.release();
  } finally {
    releaseRunnerLease(session.lease);
  }
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
  prepProcesses: readonly RunnerSession['child'][],
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
  try {
    process.kill(-pid, signal);
  } catch {}
  try {
    process.kill(pid, signal);
  } catch {}
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
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
