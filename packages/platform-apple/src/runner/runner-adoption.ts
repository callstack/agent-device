import path from 'node:path';
import {
  resolveIosSimulatorDeviceSetPath,
  emitDiagnostic,
  isProcessAlive,
  parseBooleanLiteral,
  type ExecResult,
} from './host.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import {
  resolveRunnerHandoffTarget,
  type RunnerHandoffLane,
  type RunnerHandoffRefusal,
} from './apple-runner-platform.ts';
import { sendRunnerCommandOnce } from './runner-transport.ts';
import {
  decodeRunnerResponseBody,
  isRunnerResponseOk,
  withRunnerCommandId,
} from './runner-contract.ts';
import {
  buildRunnerLease,
  readRunnerLeaseForAdoption,
  verifyLeaseRunnerPidIdentity,
  writeRunnerLease,
  type RunnerLease,
  type RunnerLeaseAdoptionRefusal,
} from './runner-lease.ts';
import {
  requireRunnerPhaseRemainingMs,
  resolveExpectedRunnerCacheMetadata,
  resolveRunnerDerivedPath,
  type RunnerPhaseBudget,
  type RunnerXctestrunArtifact,
} from './runner-xctestrun.ts';
import {
  normalizeRunnerStartupTimeoutMs,
  type RunnerProcessHandle,
  type RunnerSession,
} from './runner-session-types.ts';

// A healthy localhost runner answers uptime in tens of milliseconds and a dead
// port refuses immediately; the timeout only bounds the wedged-runner case,
// where giving up fast matters — the probe runs under the lease lock, in
// series before the restart it would otherwise avoid.
const RUNNER_ADOPTION_PROBE_TIMEOUT_MS = 500;

// The second probe phase a physical CoreDevice device gets (#2681). The command route resolver's
// tunnel-IP cache is process-global, so a fresh daemon starts empty and a device usbmuxd does not
// list has to resolve its tunnel address through `devicectl device info details` before any byte
// reaches the runner — seconds that the tight budget above cannot contain. This is that lookup's
// allowance, kept well under the tens-of-seconds rebuild it buys off; the tight phase still runs
// first, so a cabled device never spends it. The `xctest` backend is usbmux-only with no tunnel
// route and never reaches this lane at all.
const RUNNER_ADOPTION_COLD_TUNNEL_PROBE_TIMEOUT_MS = 5_000;

const RUNNER_ADOPTION_EXIT_POLL_INTERVAL_MS = 1_000;

// Kill switch for the runner handoff across daemon restarts: disables both
// detaching healthy runners on graceful shutdown and adopting them on the next
// startup, in every handoff lane (#2681).
export function isIosRunnerDetachEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanLiteral(env.AGENT_DEVICE_IOS_RUNNER_DETACH ?? '') !== false;
}

type RunnerAdoptionRefusal =
  | RunnerHandoffRefusal
  | 'simulator_set_redirect'
  | 'lease_absent'
  | RunnerLeaseAdoptionRefusal
  | 'session_identity_mismatch'
  | 'runner_pid_missing'
  | 'runner_process_dead'
  | 'runner_pid_recycled'
  | 'expected_derived_unresolved'
  | 'artifact_fingerprint_mismatch'
  | 'probe_failed'
  /** The startup phase had nothing left to probe with, so the rebuild starts on its own clock. */
  | 'probe_budget_exhausted';

// Adopts a still-running runner left behind by a dead daemon (crash or
// graceful detach) instead of killing and restarting it: the device is a
// handoff target, the lease is stale and identity-verifiable, the artifact
// fingerprint is current, and the runner answers an uptime probe. Any miss
// reports its reason and the normal cleanup-and-start path takes over. Must run
// under the runner lease lock, like the rest of session startup.
export async function tryAdoptRunnerSessionFromLease(
  device: DeviceInfo,
  options: {
    /**
     * The startup phase's one budget: the fingerprint check below spends from it, its
     * cancellation reaches those probes, and the adopted session inherits the rest (#2422).
     */
    budget?: RunnerPhaseBudget;
    expectedRunnerSessionId?: string;
  },
): Promise<RunnerSession | null> {
  if (!isIosRunnerDetachEnabled()) return null;
  const target = resolveRunnerHandoffTarget(device);
  const skip = (reason: RunnerAdoptionRefusal, lease?: RunnerLease): null => {
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_runner_lease_adoption_skipped',
      data: {
        deviceId: device.id,
        lane: target.handoff ? target.lane : undefined,
        runnerPid: lease?.runnerPid,
        port: lease?.port,
        reason,
      },
    });
    return null;
  };
  if (!target.handoff) return skip(target.reason);
  // Custom simulator sets run behind the XCTestDevices redirect, whose
  // symlink+lock lifetime is bound to the owning session and cannot be
  // carried across daemons; scoped-set runners always restart fresh.
  if (target.lane === 'simulator' && resolveIosSimulatorDeviceSetPath(device.simulatorSetPath)) {
    return skip('simulator_set_redirect');
  }
  const claim = await claimAdoptableRunnerLease(device, target.lane, options, skip);
  if (!claim) return null;

  const session = buildAdoptedRunnerSession(
    device,
    claim.lease,
    claim.runnerPid,
    claim.expectedDerivedPath,
    options,
  );
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
      lane: target.lane,
      sessionId: session.sessionId,
      runnerPid: claim.runnerPid,
      port: claim.lease.port,
      previousOwnerPid: claim.lease.ownerPid,
    },
  });
  return session;
}

/**
 * Every check the leased runner has to pass before this daemon can take it over, including the
 * uptime probe and the identity re-check that follows it. A null return has already been reported
 * through `reportRefusal`, which keeps each reason's diagnostics next to the gate that found it.
 */
async function claimAdoptableRunnerLease(
  device: DeviceInfo,
  lane: RunnerHandoffLane,
  options: { budget?: RunnerPhaseBudget; expectedRunnerSessionId?: string },
  reportRefusal: (reason: RunnerAdoptionRefusal, lease?: RunnerLease) => void,
): Promise<{ lease: RunnerLease; runnerPid: number; expectedDerivedPath: string } | null> {
  const skip = (reason: RunnerAdoptionRefusal, lease?: RunnerLease): null => {
    reportRefusal(reason, lease);
    return null;
  };
  const leaseVerdict = readRunnerLeaseForAdoption(device.id);
  if (leaseVerdict.type === 'absent') return skip('lease_absent');
  if (leaseVerdict.type === 'refused') return skip(leaseVerdict.reason, leaseVerdict.lease);
  const lease = leaseVerdict.lease;

  const claim = claimLeasedRunner(lease, options.expectedRunnerSessionId);
  if ('refusal' in claim) return skip(claim.refusal, lease);
  const runnerPid = claim.runnerPid;

  const expectedDerived = resolveExpectedDerivedPath(device, options.budget);
  if (!expectedDerived) return skip('expected_derived_unresolved', lease);
  if (!lease.xctestrunPath.startsWith(`${expectedDerived}${path.sep}`)) {
    return skip('artifact_fingerprint_mismatch', lease);
  }
  const probe = await probeRunnerAnswersUptime(device, lease.port, lane, options.budget);
  if (probe !== 'answered') return skip(probe, lease);
  // The probe awaited network I/O — the xcodebuild can have exited and its pid
  // been recycled while the old port still answers. Re-verify before the
  // adopted lease re-stamps the pid; everything below is synchronous.
  if (!isProcessAlive(runnerPid) || !verifyLeaseRunnerPidIdentity(lease, runnerPid)) {
    return skip('runner_pid_recycled', lease);
  }
  return { lease, runnerPid, expectedDerivedPath: expectedDerived };
}

type LeasedRunnerClaim = { runnerPid: number } | { refusal: RunnerAdoptionRefusal };

/** Whether this daemon may take this lease's runner over, and under which pid. */
function claimLeasedRunner(
  lease: RunnerLease,
  expectedRunnerSessionId: string | undefined,
): LeasedRunnerClaim {
  if (expectedRunnerSessionId !== undefined && lease.sessionId !== expectedRunnerSessionId) {
    return { refusal: 'session_identity_mismatch' };
  }
  const runnerPid = lease.runnerPid;
  if (!runnerPid) return { refusal: 'runner_pid_missing' };
  if (!isProcessAlive(runnerPid)) return { refusal: 'runner_process_dead' };
  // The adopted session later signals this pid on disposal — and adoption
  // re-stamps the lease with the live pid's start time — so a pid that cannot
  // be proven to still be the leased runner must never be adopted, even if
  // some process answers the leased port. Legacy leases without a recorded
  // start time fall back to the runner-shaped command-line check.
  if (!verifyLeaseRunnerPidIdentity(lease, runnerPid)) {
    return { refusal: 'runner_pid_recycled' };
  }
  return { runnerPid };
}

/**
 * Probes with the tight budget first, and only a physical CoreDevice device that could not be
 * answered there gets the cold-tunnel phase. A lane with no tunnel route — every simulator, and any
 * device the tight phase already answered — spends exactly what it spent before #2681.
 *
 * Both phases spend the startup phase's budget (#2422): they run inside the request's lease lock, so
 * a wedged runner must not get to stretch the phase past what the request already allowed, and a
 * cancelled request has to be able to reach a probe mid-flight.
 */
async function probeRunnerAnswersUptime(
  device: DeviceInfo,
  port: number,
  lane: RunnerHandoffLane,
  budget: RunnerPhaseBudget | undefined,
): Promise<RunnerProbeOutcome> {
  const tight = await sendUptimeProbe(
    device,
    port,
    lane,
    'tight',
    RUNNER_ADOPTION_PROBE_TIMEOUT_MS,
    budget,
  );
  if (tight !== 'probe_failed') return tight;
  if (lane !== 'physical_coredevice') return 'probe_failed';
  return await sendUptimeProbe(
    device,
    port,
    lane,
    'cold_tunnel',
    RUNNER_ADOPTION_COLD_TUNNEL_PROBE_TIMEOUT_MS,
    budget,
  );
}

type RunnerProbePhase = 'tight' | 'cold_tunnel';
/** `'answered'`, or the refusal the caller reports for what kept the runner from answering. */
type RunnerProbeOutcome = 'answered' | 'probe_failed' | 'probe_budget_exhausted';

async function sendUptimeProbe(
  device: DeviceInfo,
  port: number,
  lane: RunnerHandoffLane,
  phase: RunnerProbePhase,
  capMs: number,
  budget: RunnerPhaseBudget | undefined,
): Promise<RunnerProbeOutcome> {
  const timeoutMs = runnerProbeTimeoutMs(budget, capMs);
  if (timeoutMs <= 0) return 'probe_budget_exhausted';
  const startedAtMs = Date.now();
  let answered = false;
  try {
    const response = await sendRunnerCommandOnce(
      device,
      port,
      withRunnerCommandId({ command: 'uptime' }),
      timeoutMs,
      budget?.signal,
    );
    answered = isRunnerResponseOk(decodeRunnerResponseBody(await response.text()));
    return answered ? 'answered' : 'probe_failed';
  } catch (error) {
    // A cancelled request is not a runner that failed to answer: the caller must not rebuild on it.
    if (isRequestCanceledError(error)) throw error;
    return 'probe_failed';
  } finally {
    // What each phase was allowed to spend and what it actually cost is the evidence #2681 sizes
    // these two constants against, so it is recorded rather than only reasoned about.
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_runner_lease_adoption_probe',
      durationMs: Date.now() - startedAtMs,
      data: {
        deviceId: device.id,
        port,
        lane,
        probePhase: phase,
        budgetCapMs: capMs,
        timeoutMs,
        answered,
      },
    });
  }
}

/** The probe's own cap, cut down to whatever the startup phase still has. */
function runnerProbeTimeoutMs(budget: RunnerPhaseBudget | undefined, capMs: number): number {
  if (!budget?.deadline) return capMs;
  return Math.min(capMs, Math.floor(budget.deadline.remainingMs()));
}

function resolveExpectedDerivedPath(
  device: DeviceInfo,
  budget: RunnerPhaseBudget | undefined,
): string | null {
  try {
    return resolveRunnerDerivedPath(
      device,
      resolveExpectedRunnerCacheMetadata(device, undefined, budget),
    );
  } catch (error) {
    // An unresolvable fingerprint is a miss the caller starts fresh from; a cancel is not.
    if (isRequestCanceledError(error)) throw error;
    return null;
  }
}

function buildAdoptedRunnerSession(
  device: DeviceInfo,
  lease: RunnerLease,
  runnerPid: number,
  expectedDerived: string,
  options: { budget?: RunnerPhaseBudget },
): RunnerSession & { lease: RunnerLease } {
  const sessionId = lease.sessionId;
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
    // The runner appends to this file for its whole life, so the log the previous daemon handed over
    // is still the one worth quoting; a lease from before #2681 has none (#2681).
    runnerLogPath: lease.runnerLogPath,
    // The probe already proved the runner answers commands.
    state: 'ready',
    inFlightCommands: 0,
    startupTimeoutMs: normalizeRunnerStartupTimeoutMs(
      requireRunnerPhaseRemainingMs(options.budget, 'runner_session_adoption'),
    ),
    lease: buildRunnerLease({
      deviceId: device.id,
      sessionId,
      runnerPid,
      port: lease.port,
      xctestrunPath: lease.xctestrunPath,
      jsonPath: lease.jsonPath,
      runnerLogPath: lease.runnerLogPath,
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
