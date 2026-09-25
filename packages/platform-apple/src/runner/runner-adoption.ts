import path from 'node:path';
import { emitDiagnostic, isProcessAlive, parseBooleanLiteral } from './host.ts';
import type { ExecResult } from '@agent-device/host-kit/command';
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
  isLeaseRunnerProcessIntact,
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

// What the physical lane gets instead, because its probe may have to resolve the device's tunnel
// address through `devicectl device info details` before any byte reaches the runner. A cap is not
// a sleep: a runner that answers in 8 ms answers in 8 ms under either cap, so only the refusal path
// spends the difference, and it spends it once (#2681).
const RUNNER_ADOPTION_PHYSICAL_PROBE_TIMEOUT_MS = 5_000;

const RUNNER_ADOPTION_EXIT_POLL_INTERVAL_MS = 1_000;

// Kill switch for the runner handoff across daemon restarts: disables both
// detaching healthy runners on graceful shutdown and adopting them on the next
// startup, in every handoff lane (#2681).
export function isIosRunnerDetachEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanLiteral(env.AGENT_DEVICE_IOS_RUNNER_DETACH ?? '') !== false;
}

type RunnerAdoptionRefusal =
  | RunnerHandoffRefusal
  | 'lease_absent'
  | RunnerLeaseAdoptionRefusal
  | 'session_identity_mismatch'
  | 'runner_pid_missing'
  | 'runner_process_dead'
  | 'runner_pid_recycled'
  | 'expected_derived_unresolved'
  | 'artifact_fingerprint_mismatch'
  | 'probe_failed'
  /** The runner answered but its lease could not be re-stamped, so nothing may claim it. */
  | 'lease_write_failed'
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
  const leaseVerdict = readRunnerLeaseForAdoption(device.id);
  if (leaseVerdict.type === 'absent') return skip('lease_absent');
  if (leaseVerdict.type === 'refused') return skip(leaseVerdict.reason, leaseVerdict.lease);
  const lease = leaseVerdict.lease;
  const leased = verifyLeasedRunnerProcess(lease, options.expectedRunnerSessionId);
  if ('refusal' in leased) return skip(leased.refusal, lease);
  const fingerprint = verifyLeaseArtifactFingerprint(device, lease, options.budget);
  if ('refusal' in fingerprint) return skip(fingerprint.refusal, lease);
  const runnerPid = leased.value;
  const expectedDerived = fingerprint.value;
  const probe = await probeRunnerAnswersUptime(device, lease.port, target.lane, options.budget);
  if (probe !== 'answered') return skip(probe, lease);
  // The probe awaited network I/O — the xcodebuild can have exited and its pid
  // been recycled while the old port still answers. Re-verify before the
  // adopted lease re-stamps the pid; everything below is synchronous.
  if (!isLeaseRunnerProcessIntact(lease, runnerPid)) {
    return skip('runner_pid_recycled', lease);
  }

  const session = buildAdoptedRunnerSession(device, lease, runnerPid, expectedDerived, options);
  try {
    writeRunnerLease(session.lease);
  } catch {
    return skip('lease_write_failed', lease);
  }
  emitDiagnostic({
    level: 'info',
    phase: 'ios_runner_lease_adopted',
    data: {
      deviceId: device.id,
      lane: target.lane,
      sessionId: session.sessionId,
      runnerPid,
      port: lease.port,
      previousOwnerPid: lease.ownerPid,
    },
  });
  return session;
}

/** A guard group's verdict: the value adoption needs next, or the typed reason it stopped. */
type RunnerAdoptionCheck<Value> = { value: Value } | { refusal: RunnerAdoptionRefusal };

/**
 * Whether the leased pid is a runner this daemon may take over, and the one adoption will adopt.
 * The adopted session later signals this pid on disposal — and adoption re-stamps the lease with the
 * live pid's start time — so a pid that cannot be proven to still be the leased runner must never be
 * adopted, even if some process answers the leased port. Legacy leases without a recorded start time
 * fall back to the runner-shaped command-line check.
 */
function verifyLeasedRunnerProcess(
  lease: RunnerLease,
  expectedRunnerSessionId: string | undefined,
): RunnerAdoptionCheck<number> {
  if (expectedRunnerSessionId !== undefined && lease.sessionId !== expectedRunnerSessionId) {
    return { refusal: 'session_identity_mismatch' };
  }
  const runnerPid = lease.runnerPid;
  if (!runnerPid) return { refusal: 'runner_pid_missing' };
  if (!isProcessAlive(runnerPid)) return { refusal: 'runner_process_dead' };
  if (!verifyLeaseRunnerPidIdentity(lease, runnerPid)) return { refusal: 'runner_pid_recycled' };
  return { value: runnerPid };
}

/**
 * Whether the leased build product is the one this platform would itself have built, so a runner left
 * behind by a different artifact is rebuilt rather than adopted and served to a mismatched request.
 */
function verifyLeaseArtifactFingerprint(
  device: DeviceInfo,
  lease: RunnerLease,
  budget: RunnerPhaseBudget | undefined,
): RunnerAdoptionCheck<string> {
  const expectedDerived = resolveExpectedDerivedPath(device, budget);
  if (!expectedDerived) return { refusal: 'expected_derived_unresolved' };
  if (!lease.xctestrunPath.startsWith(`${expectedDerived}${path.sep}`)) {
    return { refusal: 'artifact_fingerprint_mismatch' };
  }
  return { value: expectedDerived };
}

/**
 * Probes with the lane's cap, spent from the startup phase's budget (#2422): the probe runs inside
 * the request's lease lock, so a wedged runner must not get to stretch the phase past what the
 * request already allowed, and a cancelled request has to be able to reach a probe mid-flight.
 */
async function probeRunnerAnswersUptime(
  device: DeviceInfo,
  port: number,
  lane: RunnerHandoffLane,
  budget: RunnerPhaseBudget | undefined,
): Promise<RunnerProbeOutcome> {
  const capMs =
    lane === 'physical_coredevice'
      ? RUNNER_ADOPTION_PHYSICAL_PROBE_TIMEOUT_MS
      : RUNNER_ADOPTION_PROBE_TIMEOUT_MS;
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
    // What the probe was allowed to spend and what it actually cost is the evidence #2681 sizes
    // these caps against, so it is recorded rather than only reasoned about.
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_runner_lease_adoption_probe',
      durationMs: Date.now() - startedAtMs,
      data: {
        deviceId: device.id,
        port,
        lane,
        budgetCapMs: capMs,
        timeoutMs,
        answered,
      },
    });
  }
}

/** `'answered'`, or the refusal the caller reports for what kept the runner from answering. */
type RunnerProbeOutcome = 'answered' | 'probe_failed' | 'probe_budget_exhausted';

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
    hasAbandonedCommands: false,
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
