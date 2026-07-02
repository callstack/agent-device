import path from 'node:path';
import { resolveIosSimulatorDeviceSetPath } from '../../../../utils/device-isolation.ts';
import { emitDiagnostic } from '../../../../utils/diagnostics.ts';
import { isProcessAlive } from '../../../../utils/process-identity.ts';
import { parseBooleanLiteral } from '../../../../utils/source-value.ts';
import type { DeviceInfo } from '../../../../kernel/device.ts';
import type { ExecResult } from '../../../../utils/exec.ts';
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
import {
  buildRunnerSessionId,
  normalizeRunnerStartupTimeoutMs,
  type RunnerProcessHandle,
  type RunnerSession,
} from './runner-session-types.ts';

// A healthy localhost runner answers uptime in tens of milliseconds and a dead
// port refuses immediately; the timeout only bounds the wedged-runner case,
// where giving up fast matters — the probe runs under the lease lock, in
// series before the restart it would otherwise avoid.
const RUNNER_ADOPTION_PROBE_TIMEOUT_MS = 500;
const RUNNER_ADOPTION_EXIT_POLL_INTERVAL_MS = 1_000;

// Kill switch for the runner handoff across daemon restarts: disables both
// detaching healthy simulator runners on graceful shutdown and adopting them
// on the next startup.
export function isIosRunnerDetachEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanLiteral(env.AGENT_DEVICE_IOS_RUNNER_DETACH ?? '') !== false;
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
  // Custom simulator sets run behind the XCTestDevices redirect, whose
  // symlink+lock lifetime is bound to the owning session and cannot be
  // carried across daemons; scoped-set runners always restart fresh.
  if (resolveIosSimulatorDeviceSetPath(device.simulatorSetPath)) return null;
  const lease = readStaleRunnerLease(device.id);
  if (!lease) return null;

  const skip = (reason: string): null => {
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_runner_lease_adoption_skipped',
      data: { deviceId: device.id, runnerPid: lease.runnerPid, port: lease.port, reason },
    });
    return null;
  };

  const runnerPid = lease.runnerPid;
  if (!runnerPid) return skip('runner_pid_missing');
  if (!isProcessAlive(runnerPid)) return skip('runner_process_dead');
  const expectedDerived = resolveExpectedDerivedPath(device);
  if (!expectedDerived) return skip('expected_derived_unresolved');
  if (!lease.xctestrunPath.startsWith(`${expectedDerived}${path.sep}`)) {
    return skip('artifact_fingerprint_mismatch');
  }
  if (!(await probeRunnerAnswersUptime(device, lease.port))) return skip('probe_failed');

  const session = buildAdoptedRunnerSession(device, lease, runnerPid, expectedDerived, options);
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
      runnerPid,
      port: lease.port,
      previousOwnerPid: lease.ownerPid,
    },
  });
  return session;
}

async function probeRunnerAnswersUptime(device: DeviceInfo, port: number): Promise<boolean> {
  try {
    const response = await sendRunnerCommandOnce(
      device,
      port,
      withRunnerCommandId({ command: 'uptime' }),
      RUNNER_ADOPTION_PROBE_TIMEOUT_MS,
    );
    const payload = JSON.parse(await response.text()) as { ok?: unknown };
    return payload?.ok === true;
  } catch {
    return false;
  }
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
  expectedDerived: string,
  options: { startupTimeoutMs?: number },
): RunnerSession & { lease: RunnerLease } {
  const sessionId = buildRunnerSessionId(device.id, lease.port);
  const artifact: RunnerXctestrunArtifact = {
    xctestrunPath: lease.xctestrunPath,
    derived: expectedDerived,
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
    startupTimeoutMs: normalizeRunnerStartupTimeoutMs(options.startupTimeoutMs),
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
// ChildProcess to hold — just a pid-backed RunnerProcessHandle. A
// low-frequency poll flips exitCode and settles testPromise when the process
// actually exits, which is what the transport's early-exit detection and
// disposal wait on.
function watchDetachedRunnerProcess(pid: number): {
  child: RunnerProcessHandle;
  wait: Promise<ExecResult>;
} {
  const child: RunnerProcessHandle = { pid, exitCode: null };
  const wait = new Promise<ExecResult>((resolve) => {
    const timer = setInterval(() => {
      if (isProcessAlive(pid)) return;
      clearInterval(timer);
      child.exitCode = -1;
      resolve({ stdout: '', stderr: '', exitCode: -1 });
    }, RUNNER_ADOPTION_EXIT_POLL_INTERVAL_MS);
    timer.unref?.();
  });
  return { child, wait };
}
