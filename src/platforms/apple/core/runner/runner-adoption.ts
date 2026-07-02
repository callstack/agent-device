import path from 'node:path';
import { emitDiagnostic } from '../../../../utils/diagnostics.ts';
import { isProcessAlive } from '../../../../utils/process-identity.ts';
import type { DeviceInfo } from '../../../../kernel/device.ts';
import type { ExecResult, ExecBackgroundResult } from '../../../../utils/exec.ts';
import { sendRunnerCommandOnce } from './runner-transport.ts';
import { withRunnerCommandId } from './runner-contract.ts';
import {
  buildRunnerLease,
  readStaleRunnerLease,
  writeRunnerLease,
  type RunnerLease,
} from './runner-lease.ts';
import {
  resolveExpectedRunnerCacheMetadata,
  resolveRunnerDerivedPath,
  type RunnerXctestrunArtifact,
} from './runner-xctestrun.ts';
import type { RunnerSession } from './runner-session-types.ts';

const RUNNER_ADOPTION_PROBE_TIMEOUT_MS = 2_000;
const RUNNER_ADOPTION_EXIT_POLL_INTERVAL_MS = 1_000;

// Kill switch for the runner handoff across daemon restarts: disables both
// detaching healthy simulator runners on graceful shutdown and adopting them
// on the next startup.
export function isIosRunnerDetachEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.AGENT_DEVICE_IOS_RUNNER_DETACH?.trim().toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'off';
}

// Adopts a still-running runner left behind by a dead daemon (crash or
// graceful detach) instead of killing and restarting it: the lease must be
// stale, the xcodebuild process alive, the artifact fingerprint current, and
// the runner must answer an uptime probe. Any miss returns null and the
// normal cleanup-and-start path takes over. Must run under the runner lease
// lock, like the rest of session startup.
export async function tryAdoptRunnerSessionFromLease(
  device: DeviceInfo,
  options: { startupTimeoutMs?: number },
): Promise<RunnerSession | null> {
  if (device.kind !== 'simulator' || !isIosRunnerDetachEnabled()) return null;
  const lease = readStaleRunnerLease(device.id);
  if (!lease) return null;
  const runnerPid = lease.runnerPid;
  const rejection = runnerPid
    ? await probeAdoptableRunnerLease(device, lease, runnerPid)
    : 'runner_pid_missing';
  if (rejection || !runnerPid) {
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_runner_lease_adoption_skipped',
      data: {
        deviceId: device.id,
        runnerPid: lease.runnerPid,
        port: lease.port,
        reason: rejection,
      },
    });
    return null;
  }
  const session = buildAdoptedRunnerSession(device, lease, runnerPid, options);
  try {
    writeRunnerLease(session.lease);
  } catch {
    return null;
  }
  emitDiagnostic({
    level: 'info',
    phase: 'ios_runner_lease_adopted',
    data: {
      deviceId: device.id,
      sessionId: session.sessionId,
      runnerPid: lease.runnerPid,
      port: lease.port,
      previousOwnerPid: lease.ownerPid,
    },
  });
  return session;
}

async function probeAdoptableRunnerLease(
  device: DeviceInfo,
  lease: RunnerLease,
  runnerPid: number,
): Promise<string | null> {
  if (!isProcessAlive(runnerPid)) return 'runner_process_dead';
  const expectedDerived = resolveExpectedDerivedPath(device);
  if (!expectedDerived) return 'expected_derived_unresolved';
  if (!lease.xctestrunPath.startsWith(`${expectedDerived}${path.sep}`)) {
    return 'artifact_fingerprint_mismatch';
  }
  try {
    const response = await sendRunnerCommandOnce(
      device,
      lease.port,
      withRunnerCommandId({ command: 'uptime' }),
      RUNNER_ADOPTION_PROBE_TIMEOUT_MS,
    );
    const payload = JSON.parse(await response.text()) as { ok?: unknown };
    if (payload?.ok !== true) return 'probe_rejected';
  } catch {
    return 'probe_failed';
  }
  return null;
}

function resolveExpectedDerivedPath(device: DeviceInfo): string | null {
  try {
    return resolveRunnerDerivedPath(device, resolveExpectedRunnerCacheMetadata(device));
  } catch {
    return null;
  }
}

function buildAdoptedRunnerSession(
  device: DeviceInfo,
  lease: RunnerLease,
  runnerPid: number,
  options: { startupTimeoutMs?: number },
): RunnerSession & { lease: RunnerLease } {
  const sessionId = `${device.id}:${lease.port}:${Date.now()}`;
  const artifact: RunnerXctestrunArtifact = {
    xctestrunPath: lease.xctestrunPath,
    derived: resolveExpectedDerivedPath(device) ?? path.dirname(lease.xctestrunPath),
    cache: 'exact',
    artifact: 'valid',
    buildMs: 0,
    xctestrunPathSource: 'manifest',
    reason: 'adopted_from_lease',
  };
  const { child, wait } = watchDetachedRunnerProcess(runnerPid);
  return {
    sessionId,
    device,
    deviceId: device.id,
    port: lease.port,
    xctestrunPath: lease.xctestrunPath,
    xctestrunArtifact: artifact,
    jsonPath: lease.jsonPath,
    testPromise: wait,
    child,
    // The probe already proved the runner answers commands.
    ready: true,
    startupTimeoutMs: normalizeStartupTimeoutMs(options.startupTimeoutMs),
    lease: buildRunnerLease({
      deviceId: device.id,
      sessionId,
      runnerPid,
      port: lease.port,
      xctestrunPath: lease.xctestrunPath,
      jsonPath: lease.jsonPath,
    }),
  };
}

// The adopted xcodebuild was spawned by a dead process, so there is no
// ChildProcess handle. Downstream code only reads pid/exitCode and kills by
// pid, so a pid-backed surrogate suffices; a low-frequency poll flips
// exitCode and settles testPromise when the process actually exits, which is
// what the transport's early-exit detection and disposal wait on.
function watchDetachedRunnerProcess(pid: number): {
  child: ExecBackgroundResult['child'];
  wait: Promise<ExecResult>;
} {
  const child = { pid, exitCode: null } as unknown as ExecBackgroundResult['child'];
  const wait = new Promise<ExecResult>((resolve) => {
    const timer = setInterval(() => {
      if (isProcessAlive(pid)) return;
      clearInterval(timer);
      (child as { exitCode: number | null }).exitCode = -1;
      resolve({ stdout: '', stderr: '', exitCode: -1 });
    }, RUNNER_ADOPTION_EXIT_POLL_INTERVAL_MS);
    timer.unref?.();
  });
  return { child, wait };
}

function normalizeStartupTimeoutMs(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}
