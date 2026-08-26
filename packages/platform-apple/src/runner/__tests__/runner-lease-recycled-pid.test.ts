import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'vitest';
import { mkdtempForTestSync } from './tmp-dir.ts';
import { runCmdBackground, readProcessStartTime, type ExecBackgroundResult } from '../host.ts';
import {
  runnerOwnerToken,
  cleanupOwnedRunnerLease,
  writeRunnerLease,
  type RunnerLease,
  type RunnerLeaseCleanupAdapter,
} from '../runner-lease.ts';

/**
 * #1621 (recycled runner pid) as a real-process scenario rather than
 * `readProcessStartTime` mock choreography, per #1631's acceptance criteria.
 *
 * A lease file can outlive its runner by days, and the OS recycles pids — so
 * a stale lease's `runnerPid` may now belong to somebody else's process.
 * Here that "somebody else" is a REAL child process we spawn and own: its pid
 * and start time come from the OS, and `readProcessStartTime` runs for real.
 * The lease then claims that pid with a start time that does not match, which
 * is exactly the recycled shape. Cleanup must refuse to signal it.
 *
 * Asserting through the injected cleanup adapter (a production seam, not a
 * test-only one) rather than by observing a kill keeps the test safe: a
 * regression reports a pid here instead of signalling a live process.
 *
 * The lease is written under this process's own owner token, so cleanup
 * classifies it as `owned` without reading the OWNER's start time — the one
 * `ps` read this test needs is the child's, which is its actual subject.
 * Depending on owner-identity reads is what makes such tests flake under
 * full-suite contention (see #1642).
 *
 * Deliberately only the refusal direction. It is contention-PROOF: the
 * recorded start time never matches, so whether the verification read
 * succeeds or times out under load, the verdict is the same refusal. The
 * opposite direction ("identity matches, so signal") cannot be made robust
 * with a real process — it needs a second live `ps` read inside production
 * code, and a timed-out read there flips the result. That direction is
 * covered by the mocked start-time cases in `runner-session.test.ts`, where
 * pinning the read is the point rather than a workaround.
 */

// Process execution goes through utils/exec.ts, never node:child_process
// directly (AGENTS.md hard rule) — including in tests.
let child: ExecBackgroundResult | undefined;
let previousLeaseDir: string | undefined;

beforeEach(() => {
  // Leases default to the REAL ~/.agent-device tree; redirect them so the
  // suite never writes into the developer's own runner state.
  previousLeaseDir = process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR;
  process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = mkdtempForTestSync('agent-device-lease-root-');
});

afterEach(() => {
  child?.child.kill('SIGKILL');
  child = undefined;
  if (previousLeaseDir === undefined) {
    delete process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR;
  } else {
    process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = previousLeaseDir;
  }
});

function recordingCleanup(): {
  adapter: RunnerLeaseCleanupAdapter;
  signalledPids: (number | undefined)[];
} {
  const signalledPids: (number | undefined)[] = [];
  return {
    signalledPids,
    adapter: {
      cleanupRunnerProcessTree: async (pid) => {
        signalledPids.push(pid);
      },
      cleanupRunnerXcodebuildProcesses: async () => {},
      cleanupTempFile: () => {},
    },
  };
}

async function spawnRealChild(): Promise<{ pid: number; startTime: string | null }> {
  child = runCmdBackground('sleep', ['30']);
  // The cleanup SIGKILL below makes `wait` reject; own that here so it is a
  // deliberate no-op rather than an unhandled rejection.
  child.wait.catch(() => {});
  const pid = child.child.pid;
  assert.ok(pid, 'the OS gave the child a pid');
  // `readProcessStartTime` shells out to `ps`, which under full-suite CPU
  // contention can miss its own timeout and return null. The budget is
  // generous because it is only ever paid when contended — a quiet machine
  // answers on the first read.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const startTime = readProcessStartTime(pid);
    if (startTime) return { pid, startTime };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('could not read the real child start time within 10s');
}

function leaseFor(params: {
  deviceId: string;
  runnerPid: number;
  runnerStartTime: string | null;
  stateDir: string;
}): RunnerLease {
  return {
    schemaVersion: 1,
    deviceId: params.deviceId,
    ownerToken: runnerOwnerToken(),
    ownerPid: process.pid,
    ownerStartTime: null,
    ownerStateDir: params.stateDir,
    sessionId: `session-${params.deviceId}`,
    runnerPid: params.runnerPid,
    runnerStartTime: params.runnerStartTime,
    port: 8100,
    xctestrunPath: `${params.stateDir}/runner.xctestrun`,
    jsonPath: `${params.stateDir}/runner.json`,
    createdAtMs: Date.now(),
  };
}

test('a lease whose runner pid was recycled is never signalled', async () => {
  const stateDir = mkdtempForTestSync('agent-device-lease-recycled-');
  const real = await spawnRealChild();
  // Same pid, different start time: the process at this pid is NOT the runner
  // the lease recorded. This is the recycled case, produced without touching
  // a single process API.
  const deviceId = `recycled-${real.pid}`;
  writeRunnerLease(
    leaseFor({
      deviceId,
      runnerPid: real.pid,
      runnerStartTime: '1970-01-01T00:00:00Z',
      stateDir,
    }),
  );
  const cleanup = recordingCleanup();

  await cleanupOwnedRunnerLease(deviceId, cleanup.adapter);

  assert.deepEqual(
    cleanup.signalledPids,
    [undefined, undefined],
    'both the SIGTERM and SIGKILL passes refuse the unverified pid',
  );
  assert.equal(child?.child.killed, false, 'the real process was left alone');
  // Guards the assertion above against passing for the wrong reason: cleanup
  // must actually have run (a lease that classified as anything but `owned`
  // would also produce no signals).
  assert.equal(cleanup.signalledPids.length, 2, 'cleanup ran both signal passes');
});
