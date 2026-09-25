import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createRequestCanceledError, isRequestCanceledError } from '@agent-device/kernel/errors';
import { resetAllProcessMemosForTests } from '@agent-device/kernel/ttl-memo';
import {
  buildDetachedRunnerLease,
  buildRunnerLease,
  readStaleRunnerLease,
  writeRunnerLease,
  type RunnerLease,
} from '../runner-lease.ts';
import { isIosRunnerDetachEnabled, tryAdoptRunnerSessionFromLease } from '../runner-adoption.ts';
import { sendRunnerCommandOnce } from '../runner-transport.ts';
import {
  createRunnerPhaseBudget,
  resolveExpectedRunnerCacheMetadata,
} from '../runner-xctestrun.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import type { DiagnosticEventInput } from '@agent-device/host-kit/diagnostics';
import { appleToolchainProbeResult } from './apple-toolchain-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

vi.mock('../runner-transport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner-transport.ts')>();
  return { ...actual, sendRunnerCommandOnce: vi.fn() };
});
vi.mock('../runner-xctestrun.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner-xctestrun.ts')>();
  return {
    ...actual,
    resolveExpectedRunnerCacheMetadata: vi.fn(() => ({})),
    resolveRunnerDerivedPath: vi.fn(() => expectedDerived),
  };
});

const mockSendRunnerCommandOnce = vi.mocked(sendRunnerCommandOnce);
const mockResolveExpectedRunnerCacheMetadata = vi.mocked(resolveExpectedRunnerCacheMetadata);
const mockIsProcessAlive = vi.fn((_pid: number) => false);
const mockReadProcessCommand = vi.fn((_pid: number): string | null => null);
const mockReadProcessStartTime = vi.fn((_pid: number): string | null => 'test-process-start');

// A refusal only exists as a diagnostic, so the refusal matrix reads what adoption emitted rather
// than what it returned.
let emittedDiagnostics: DiagnosticEventInput[] = [];

function adoptionRefusalReason(): unknown {
  return emittedDiagnostics
    .filter((event) => event.phase === 'ios_runner_lease_adoption_skipped')
    .at(-1)?.data?.reason;
}

function adoptionProbeTimeouts(): unknown[] {
  return emittedDiagnostics
    .filter((event) => event.phase === 'ios_runner_lease_adoption_probe')
    .map((event) => event.data?.timeoutMs);
}

function adoptionProbes(): unknown[] {
  return emittedDiagnostics
    .filter((event) => event.phase === 'ios_runner_lease_adoption_probe')
    .map((event) => `${event.data?.lane}:${event.data?.budgetCapMs}:${event.data?.answered}`);
}

beforeEach(() => {
  emittedDiagnostics = [];
  appleRunnerTestHost.update({
    isProcessAlive: mockIsProcessAlive,
    readProcessCommand: mockReadProcessCommand,
    readProcessStartTime: mockReadProcessStartTime,
    emitDiagnostic: (event) => {
      emittedDiagnostics.push(event);
    },
  });
});

const simulator: DeviceInfo = {
  platform: 'apple',
  id: 'adopt-sim-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

// The physical lanes #2681 added: the CoreDevice-backed device handoff covers, and the usbmux-only
// XCTest backend it explicitly refuses.
const physicalCoreDevice: DeviceInfo = {
  platform: 'apple',
  id: 'adopt-device-1',
  name: 'iPhone 17 Pro',
  kind: 'device',
  target: 'mobile',
  appleOs: 'ios',
  iosPhysicalDeviceBackend: 'coredevice',
  booted: true,
};

const physicalXctestDevice: DeviceInfo = {
  ...physicalCoreDevice,
  id: 'adopt-device-xctest',
  iosPhysicalDeviceBackend: 'xctest',
};

let leaseDir: string;
let expectedDerived: string;

function writeStaleLeaseFor(device: DeviceInfo, overrides: Partial<RunnerLease> = {}): RunnerLease {
  const lease: RunnerLease = {
    ...buildRunnerLease({
      device,
      sessionId: `${device.id}:50700:1`,
      runnerPid: 424242,
      port: 50700,
      xctestrunPath: path.join(expectedDerived, 'Build', 'Products', 'env.session.xctestrun'),
      jsonPath: path.join(expectedDerived, 'Build', 'Products', 'env.session.json'),
    }),
    // A pid+start-time that cannot belong to a live process makes the lease
    // owner dead, i.e. the lease classifies as stale.
    ownerToken: 'owner-99999-deadbeef',
    ownerPid: 99999,
    ownerStartTime: 'not-a-real-start-time',
    ...overrides,
  };
  writeRunnerLease(lease);
  return lease;
}

function writeStaleLease(overrides: Partial<RunnerLease> = {}): RunnerLease {
  return writeStaleLeaseFor(simulator, overrides);
}

beforeEach(() => {
  leaseDir = mkdtempForTestSync('agent-device-lease-test-');
  process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = leaseDir;
  expectedDerived = path.join(leaseDir, 'derived');
  mockSendRunnerCommandOnce.mockReset();
  mockIsProcessAlive.mockReset();
  mockIsProcessAlive.mockReturnValue(false);
  mockReadProcessCommand.mockReset();
  mockReadProcessCommand.mockReturnValue(null);
  mockReadProcessStartTime.mockReset();
  mockReadProcessStartTime.mockReturnValue('test-process-start');
  delete process.env.AGENT_DEVICE_IOS_RUNNER_DETACH;
});

afterEach(() => {
  delete process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR;
  delete process.env.AGENT_DEVICE_IOS_RUNNER_DETACH;
  fs.rmSync(leaseDir, { recursive: true, force: true });
});

test('isIosRunnerDetachEnabled honors the kill switch', () => {
  expect(isIosRunnerDetachEnabled({})).toBe(true);
  expect(isIosRunnerDetachEnabled({ AGENT_DEVICE_IOS_RUNNER_DETACH: '0' })).toBe(false);
  expect(isIosRunnerDetachEnabled({ AGENT_DEVICE_IOS_RUNNER_DETACH: 'false' })).toBe(false);
  expect(isIosRunnerDetachEnabled({ AGENT_DEVICE_IOS_RUNNER_DETACH: '1' })).toBe(true);
});

test('readStaleRunnerLease returns dead-owner leases and skips owned ones', () => {
  writeStaleLease();
  expect(readStaleRunnerLease(simulator.id)?.port).toBe(50700);

  // A lease written by this process is owned, not stale.
  writeRunnerLease(
    buildRunnerLease({
      device: simulator,
      sessionId: `${simulator.id}:50700:2`,
      runnerPid: 424242,
      port: 50700,
      xctestrunPath: '/tmp/x.xctestrun',
      jsonPath: '/tmp/x.json',
    }),
  );
  expect(readStaleRunnerLease(simulator.id)).toBeNull();
});

test('buildDetachedRunnerLease rewrites the token', () => {
  const lease = writeStaleLease();
  expect(buildDetachedRunnerLease(lease).ownerToken).toBe(`detached-${lease.ownerToken}`);
});

test('adoption succeeds for a live, matching, probe-healthy runner', async () => {
  const lease = writeStaleLease();
  mockIsProcessAlive.mockReturnValue(true);
  mockSendRunnerCommandOnce.mockResolvedValue(new Response(JSON.stringify({ ok: true })));

  const session = await tryAdoptRunnerSessionFromLease(simulator, {});

  expect(session).not.toBeNull();
  expect(session?.port).toBe(lease.port);
  expect(session?.state).toBe('ready');
  expect(session?.child.pid).toBe(424242);
  expect(session?.sessionId).toBe(lease.sessionId);
  expect(session?.xctestrunArtifact?.reason).toBe('adopted_from_lease');
  // Adoption transfers ownership: the lease on disk now belongs to us.
  expect(readStaleRunnerLease(simulator.id)).toBeNull();
});

test('the adopted runner keeps the log file its predecessor opened for it', async () => {
  // The runner inherited that descriptor at spawn, so the next daemon has to keep writing to the
  // same path a client was already told about (#2681).
  const runnerLogPath = path.join(leaseDir, 'runner.log');
  writeStaleLease({ runnerLogPath });
  mockIsProcessAlive.mockReturnValue(true);
  mockSendRunnerCommandOnce.mockResolvedValue(new Response(JSON.stringify({ ok: true })));

  const session = await tryAdoptRunnerSessionFromLease(simulator, {});

  expect(session?.runnerLogPath).toBe(runnerLogPath);
  const restamped = JSON.parse(
    fs.readFileSync(path.join(leaseDir, `${simulator.id}.json`), 'utf8'),
  ) as RunnerLease;
  expect(restamped.runnerLogPath).toBe(runnerLogPath);
});

test('a request canceled during the fingerprint probe fails adoption instead of skipping it, cold or with the fingerprint cache warm', async () => {
  // The fingerprint check runs the same blocking toolchain probes a fresh
  // startup would, and it is handed the request's signal. A cancellation from
  // there is not an unresolvable derived path: swallowing it would let startup
  // walk on past a client that is already gone (#2422).
  const lease = writeStaleLease();
  mockIsProcessAlive.mockReturnValue(true);
  const request = new AbortController();
  request.abort();
  mockResolveExpectedRunnerCacheMetadata.mockImplementationOnce((_device, _projectRoot, budget) => {
    // The probe only cancels because the request's signal reached it.
    expect(budget?.signal?.aborted).toBe(true);
    throw createRequestCanceledError({ phase: 'apple_toolchain_probe' });
  });

  await expect(
    tryAdoptRunnerSessionFromLease(simulator, {
      budget: createRunnerPhaseBudget(undefined, request.signal),
    }),
  ).rejects.toSatisfy(isRequestCanceledError);
  expect(mockSendRunnerCommandOnce).not.toHaveBeenCalled();

  // The mock above only proves adoption propagates whatever the fingerprint
  // call throws. Exercise the real production code path too: warm the actual
  // toolchain fingerprint memo (the module-level cache in
  // runner-cache-metadata.ts is a singleton the mock above never touches),
  // then adopt again with an already-aborted signal. Before the fix,
  // requireRunnerToolchainFingerprint returned the memoized value without
  // checking the signal, so a cache hit let adoption go on to probe uptime
  // and write the lease for an already-canceled request (#2422 round 4).
  resetAllProcessMemosForTests();
  const { resolveExpectedRunnerCacheMetadata: actualResolveExpectedRunnerCacheMetadata } =
    await vi.importActual<typeof import('../runner-xctestrun.ts')>('../runner-xctestrun.ts');
  appleRunnerTestHost.update({ runCmdSync: vi.fn(appleToolchainProbeResult) });
  actualResolveExpectedRunnerCacheMetadata(simulator);

  const warmRequest = new AbortController();
  warmRequest.abort();
  mockResolveExpectedRunnerCacheMetadata.mockImplementationOnce(
    actualResolveExpectedRunnerCacheMetadata,
  );

  await expect(
    tryAdoptRunnerSessionFromLease(simulator, {
      budget: createRunnerPhaseBudget(undefined, warmRequest.signal),
    }),
  ).rejects.toSatisfy(isRequestCanceledError);
  expect(mockSendRunnerCommandOnce).not.toHaveBeenCalled();
  // Ownership was never transferred: the stale lease is untouched.
  expect(readStaleRunnerLease(simulator.id)?.ownerToken).toBe(lease.ownerToken);
});

test('adoption is skipped for a recycled runner pid (start time mismatch)', async () => {
  // The live process on the leased pid started at a different time than the
  // lease recorded — pid recycled since the owner died (#1596). Adopting it
  // would make later disposal signal an innocent process.
  writeStaleLease({ runnerStartTime: 'runner-original-start' });
  mockIsProcessAlive.mockReturnValue(true);

  expect(await tryAdoptRunnerSessionFromLease(simulator, {})).toBeNull();
  expect(mockSendRunnerCommandOnce).not.toHaveBeenCalled();
});

test('adoption is refused when the pid is recycled while the uptime probe is in flight', async () => {
  // Identity holds at the first check, then the xcodebuild exits and its pid
  // is recycled during the awaited probe while the old port still answers.
  // Adoption must re-verify after the probe: re-stamping the recycled pid
  // would hand disposal a strongly-verified lease over an innocent process.
  const lease = writeStaleLease();
  mockIsProcessAlive.mockReturnValue(true);
  mockSendRunnerCommandOnce.mockImplementation(async () => {
    mockReadProcessStartTime.mockReturnValue('recycled-during-probe-start');
    return new Response(JSON.stringify({ ok: true }));
  });

  expect(await tryAdoptRunnerSessionFromLease(simulator, {})).toBeNull();
  // The stale lease must survive untouched — ownership was never transferred.
  expect(readStaleRunnerLease(simulator.id)?.ownerToken).toBe(lease.ownerToken);
});

test('adoption is skipped for a legacy lease whose live pid is not runner-shaped', async () => {
  // Leases written before `runnerStartTime` existed carry no start time; the
  // only identity evidence left is the command line. An unverified pid must
  // not be adopted — adoption re-stamps the lease with the live pid's start
  // time, so a recycled pid would be laundered into a strongly-verified lease
  // that disposal later kills.
  writeStaleLease({ runnerStartTime: null });
  mockIsProcessAlive.mockReturnValue(true);
  mockReadProcessCommand.mockReturnValue('node /usr/local/bin/opencode run --model gpt-high');

  expect(await tryAdoptRunnerSessionFromLease(simulator, {})).toBeNull();
  expect(mockSendRunnerCommandOnce).not.toHaveBeenCalled();
});

test('adoption accepts a legacy lease whose live pid is runner-shaped', async () => {
  writeStaleLease({ runnerStartTime: null });
  mockIsProcessAlive.mockReturnValue(true);
  mockReadProcessCommand.mockReturnValue(
    'xcodebuild test-without-building -xctestrun /tmp/AgentDeviceRunner.env.session-x.xctestrun',
  );
  mockSendRunnerCommandOnce.mockResolvedValue(new Response(JSON.stringify({ ok: true })));

  const session = await tryAdoptRunnerSessionFromLease(simulator, {});

  expect(session?.state).toBe('ready');
  expect(session?.child.pid).toBe(424242);
});

test('a runner for a simulator in a custom simulator set is adopted', async () => {
  const scopedDevice = { ...simulator, simulatorSetPath: '/custom/device-set' };
  writeStaleLeaseFor(scopedDevice);
  mockIsProcessAlive.mockReturnValue(true);
  mockSendRunnerCommandOnce.mockResolvedValue(new Response(JSON.stringify({ ok: true })));

  const session = await tryAdoptRunnerSessionFromLease(scopedDevice, {});

  expect(session?.state).toBe('ready');
  expect(session?.device.simulatorSetPath).toBe('/custom/device-set');
  const restamped = JSON.parse(
    fs.readFileSync(path.join(leaseDir, `${scopedDevice.id}.json`), 'utf8'),
  ) as RunnerLease;
  expect(restamped.simulatorSetPath).toBe('/custom/device-set');
});

test('a runner leased for the same udid in another simulator set is never adopted', async () => {
  mockIsProcessAlive.mockReturnValue(true);
  mockSendRunnerCommandOnce.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  const tenantA = { ...simulator, simulatorSetPath: '/custom/tenant-a' };
  const tenantB = { ...simulator, simulatorSetPath: '/custom/tenant-b' };

  for (const [leasedFor, requested] of [
    [tenantA, tenantB],
    [tenantA, simulator],
    [simulator, tenantA],
  ] as const) {
    writeStaleLeaseFor(leasedFor);

    expect(await tryAdoptRunnerSessionFromLease(requested, {})).toBeNull();
    expect(adoptionRefusalReason()).toBe('simulator_set_mismatch');
  }
  expect(mockSendRunnerCommandOnce).not.toHaveBeenCalled();
});

test('adoption is skipped when the runner process is dead', async () => {
  writeStaleLease();
  mockIsProcessAlive.mockReturnValue(false);

  expect(await tryAdoptRunnerSessionFromLease(simulator, {})).toBeNull();
  expect(mockSendRunnerCommandOnce).not.toHaveBeenCalled();
});

test('adoption is skipped on artifact fingerprint mismatch', async () => {
  writeStaleLease({ xctestrunPath: '/somewhere/else/Build/Products/env.xctestrun' });
  mockIsProcessAlive.mockReturnValue(true);

  expect(await tryAdoptRunnerSessionFromLease(simulator, {})).toBeNull();
  expect(mockSendRunnerCommandOnce).not.toHaveBeenCalled();
});

test('adoption is skipped when the probe fails', async () => {
  writeStaleLease();
  mockIsProcessAlive.mockReturnValue(true);
  mockSendRunnerCommandOnce.mockRejectedValue(new Error('connection refused'));

  expect(await tryAdoptRunnerSessionFromLease(simulator, {})).toBeNull();
});

// #2662: the probe decodes through the command path's decoder, so a body that
// path would refuse cannot be read as an answer here either. Adoption must not
// re-stamp the lease for a runner it cannot read.
test('adoption is skipped when the uptime probe answers a truncated body', async () => {
  const lease = writeStaleLease();
  mockIsProcessAlive.mockReturnValue(true);
  mockSendRunnerCommandOnce.mockResolvedValue(new Response('{"ok":true,"data":{"uptime":'));

  expect(await tryAdoptRunnerSessionFromLease(simulator, {})).toBeNull();
  expect(readStaleRunnerLease(simulator.id)?.ownerToken).toBe(lease.ownerToken);
});

test('adoption is skipped when the uptime probe answers an ok that is not the boolean true', async () => {
  const lease = writeStaleLease();
  mockIsProcessAlive.mockReturnValue(true);
  mockSendRunnerCommandOnce.mockResolvedValue(new Response('{"ok":"true"}'));

  expect(await tryAdoptRunnerSessionFromLease(simulator, {})).toBeNull();
  expect(readStaleRunnerLease(simulator.id)?.ownerToken).toBe(lease.ownerToken);
});

test('adoption is disabled by the kill switch', async () => {
  writeStaleLease();
  mockIsProcessAlive.mockReturnValue(true);
  process.env.AGENT_DEVICE_IOS_RUNNER_DETACH = '0';

  expect(await tryAdoptRunnerSessionFromLease(simulator, {})).toBeNull();
});

test('adoption is refused when the owner state dir is gone but the owner process is alive', async () => {
  // The owner daemon is ALIVE (same pid/start-time as this process) but its
  // AGENT_DEVICE_STATE_DIR was deleted. Such a lease is reclaimable, but only
  // via the force-stop path: silently adopting a runner whose live owner
  // still believes it owns it would create two masters. Adoption must refuse
  // it outright - before ever probing the runner.
  const goneStateDir = mkdtempForTestSync('agent-device-adopt-dir-gone-');
  fs.rmSync(goneStateDir, { recursive: true, force: true });
  writeStaleLease({
    ownerToken: 'owner-foreign-dir-gone',
    ownerPid: process.pid,
    // classifyOwnerLiveness runs unmocked here (it is a single opaque host
    // capability, not decomposable into our isProcessAlive/readProcessStartTime
    // overrides), so it independently reads this process's REAL start time.
    // Matching that keeps this lease's owner classified as genuinely alive.
    ownerStartTime: appleRunnerTestHost.defaults().readProcessStartTime(process.pid),
    ownerStateDir: goneStateDir,
  });
  mockIsProcessAlive.mockReturnValue(true);

  expect(readStaleRunnerLease(simulator.id)).toBeNull();
  expect(await tryAdoptRunnerSessionFromLease(simulator, {})).toBeNull();
  expect(mockSendRunnerCommandOnce).not.toHaveBeenCalled();
});

// #2681: the physical lane. These are automated refusal decisions over the handoff gate — they are
// not the live-device proof, which `docs/agents/device-verification.md` and
// `docs/evidence/ios-physical-runner-handoff-2026-09-19.md` own.
test('physical coredevice lane adopts the detached runner and names its lane', async () => {
  const lease = writeStaleLeaseFor(physicalCoreDevice);
  mockIsProcessAlive.mockReturnValue(true);
  mockSendRunnerCommandOnce.mockResolvedValue(new Response(JSON.stringify({ ok: true })));

  const session = await tryAdoptRunnerSessionFromLease(physicalCoreDevice, {});

  expect(session?.state).toBe('ready');
  expect(session?.child.pid).toBe(lease.runnerPid);
  expect(session?.port).toBe(lease.port);
  expect(
    emittedDiagnostics.find((event) => event.phase === 'ios_runner_lease_adopted')?.data,
  ).toMatchObject({ deviceId: physicalCoreDevice.id, lane: 'physical_coredevice' });
  // Ownership transferred: the adopted lease is no longer stale for a third daemon.
  expect(readStaleRunnerLease(physicalCoreDevice.id)).toBeNull();
});

test('physical lane refuses the usbmux-only xctest backend before reading anything', async () => {
  writeStaleLeaseFor(physicalXctestDevice);
  mockIsProcessAlive.mockReturnValue(true);

  expect(await tryAdoptRunnerSessionFromLease(physicalXctestDevice, {})).toBeNull();
  expect(adoptionRefusalReason()).toBe('xctest_backend');
  expect(mockSendRunnerCommandOnce).not.toHaveBeenCalled();
});

test('physical lane refuses the macOS host, which is kind device too', async () => {
  const macHost: DeviceInfo = { ...physicalCoreDevice, id: 'host-macos', appleOs: 'macos' };

  expect(await tryAdoptRunnerSessionFromLease(macHost, {})).toBeNull();
  expect(adoptionRefusalReason()).toBe('macos_host');
  expect(mockSendRunnerCommandOnce).not.toHaveBeenCalled();
});

test('physical refusal matrix: no lease on disk', async () => {
  mockIsProcessAlive.mockReturnValue(true);

  expect(await tryAdoptRunnerSessionFromLease(physicalCoreDevice, {})).toBeNull();
  expect(adoptionRefusalReason()).toBe('lease_absent');
});

test('physical refusal matrix: the lease is not stale because its owner is alive', async () => {
  const liveStateDir = mkdtempForTestSync('agent-device-adopt-owner-live-');
  appleRunnerTestHost.update({ leaseOwnerStateDir: () => liveStateDir });
  writeStaleLeaseFor(physicalCoreDevice, {
    ownerToken: 'owner-foreign-live',
    ownerPid: process.pid,
    ownerStartTime: appleRunnerTestHost.defaults().readProcessStartTime(process.pid),
    ownerStateDir: liveStateDir,
  });
  mockIsProcessAlive.mockReturnValue(true);

  expect(await tryAdoptRunnerSessionFromLease(physicalCoreDevice, {})).toBeNull();
  expect(adoptionRefusalReason()).toBe('lease_owner_live');
  expect(mockSendRunnerCommandOnce).not.toHaveBeenCalled();
});

test('physical refusal matrix: the leased runner pid is dead', async () => {
  writeStaleLeaseFor(physicalCoreDevice);
  mockIsProcessAlive.mockReturnValue(false);

  expect(await tryAdoptRunnerSessionFromLease(physicalCoreDevice, {})).toBeNull();
  expect(adoptionRefusalReason()).toBe('runner_process_dead');
  expect(mockSendRunnerCommandOnce).not.toHaveBeenCalled();
});

test('physical refusal matrix: the leased runner pid was recycled', async () => {
  writeStaleLeaseFor(physicalCoreDevice, { runnerStartTime: 'runner-original-start' });
  mockIsProcessAlive.mockReturnValue(true);

  expect(await tryAdoptRunnerSessionFromLease(physicalCoreDevice, {})).toBeNull();
  expect(adoptionRefusalReason()).toBe('runner_pid_recycled');
  expect(mockSendRunnerCommandOnce).not.toHaveBeenCalled();
});

test('physical refusal matrix: the artifact fingerprint moved', async () => {
  writeStaleLeaseFor(physicalCoreDevice, {
    xctestrunPath: '/somewhere/else/Build/Products/env.xctestrun',
  });
  mockIsProcessAlive.mockReturnValue(true);

  expect(await tryAdoptRunnerSessionFromLease(physicalCoreDevice, {})).toBeNull();
  expect(adoptionRefusalReason()).toBe('artifact_fingerprint_mismatch');
  expect(mockSendRunnerCommandOnce).not.toHaveBeenCalled();
});

test('physical refusal matrix: the caller expected another runner session', async () => {
  writeStaleLeaseFor(physicalCoreDevice);
  mockIsProcessAlive.mockReturnValue(true);

  expect(
    await tryAdoptRunnerSessionFromLease(physicalCoreDevice, {
      expectedRunnerSessionId: 'some-other-runner-session',
    }),
  ).toBeNull();
  expect(adoptionRefusalReason()).toBe('session_identity_mismatch');
  expect(mockSendRunnerCommandOnce).not.toHaveBeenCalled();
});

test('physical refusal matrix: the owner is alive with its owner-state dir gone', async () => {
  // Stale enough for the force-stop path to reclaim, never for adoption: adopting a runner whose
  // live owner still believes it owns it would create two masters.
  const goneStateDir = mkdtempForTestSync('agent-device-adopt-dir-gone-device-');
  fs.rmSync(goneStateDir, { recursive: true, force: true });
  writeStaleLeaseFor(physicalCoreDevice, {
    ownerToken: 'owner-foreign-dir-gone',
    ownerPid: process.pid,
    // classifyOwnerLiveness runs unmocked, so it reads this process's REAL start time.
    ownerStartTime: appleRunnerTestHost.defaults().readProcessStartTime(process.pid),
    ownerStateDir: goneStateDir,
  });
  mockIsProcessAlive.mockReturnValue(true);

  expect(await tryAdoptRunnerSessionFromLease(physicalCoreDevice, {})).toBeNull();
  expect(adoptionRefusalReason()).toBe('lease_owner_state_dir_gone');
  expect(mockSendRunnerCommandOnce).not.toHaveBeenCalled();
});

test('physical refusal matrix: an unreachable device spends one probe and its own cap', async () => {
  writeStaleLeaseFor(physicalCoreDevice);
  mockIsProcessAlive.mockReturnValue(true);
  mockSendRunnerCommandOnce.mockRejectedValue(new Error('connection refused'));
  const lease = readStaleRunnerLease(physicalCoreDevice.id);

  expect(await tryAdoptRunnerSessionFromLease(physicalCoreDevice, {})).toBeNull();
  // One probe, on the lane's cap - which is the whole reason the physical lane needs a bigger cap
  // than the simulator lane: the tunnel address may have to be looked up inside it (#2681).
  expect(adoptionProbeTimeouts()).toEqual([5_000]);
  expect(adoptionProbes()).toEqual(['physical_coredevice:5000:false']);
  expect(adoptionRefusalReason()).toBe('probe_failed');
  expect(readStaleRunnerLease(physicalCoreDevice.id)?.ownerToken).toBe(lease?.ownerToken);
});

test('a simulator spends the tight probe cap it spent before #2681', async () => {
  writeStaleLease();
  mockIsProcessAlive.mockReturnValue(true);
  mockSendRunnerCommandOnce.mockRejectedValue(new Error('connection refused'));

  expect(await tryAdoptRunnerSessionFromLease(simulator, {})).toBeNull();
  expect(adoptionProbeTimeouts()).toEqual([500]);
  expect(adoptionProbes()).toEqual(['simulator:500:false']);
});

test('the probe spends the startup budget it was handed instead of getting a fresh one', async () => {
  // Adoption runs inside the request's lease lock, so an unclamped probe could hold it for five
  // seconds after the request itself had seconds left (#2422).
  writeStaleLeaseFor(physicalCoreDevice);
  mockIsProcessAlive.mockReturnValue(true);
  mockSendRunnerCommandOnce.mockRejectedValue(new Error('connection refused'));

  expect(
    await tryAdoptRunnerSessionFromLease(physicalCoreDevice, {
      budget: createRunnerPhaseBudget(1_200, undefined),
    }),
  ).toBeNull();

  const [timeoutMs] = adoptionProbeTimeouts() as number[];
  expect(timeoutMs).toBeGreaterThan(0);
  expect(timeoutMs).toBeLessThan(5_000);
});

test('a budget the fingerprint check already spent refuses adoption instead of probing at zero', async () => {
  writeStaleLeaseFor(physicalCoreDevice);
  mockIsProcessAlive.mockReturnValue(true);
  const lease = readStaleRunnerLease(physicalCoreDevice.id);

  expect(
    await tryAdoptRunnerSessionFromLease(physicalCoreDevice, {
      budget: createRunnerPhaseBudget(0, undefined),
    }),
  ).toBeNull();

  expect(mockSendRunnerCommandOnce).not.toHaveBeenCalled();
  expect(adoptionRefusalReason()).toBe('probe_budget_exhausted');
  expect(readStaleRunnerLease(physicalCoreDevice.id)?.ownerToken).toBe(lease?.ownerToken);
});

test('the kill switch disables the physical lane too', async () => {
  writeStaleLeaseFor(physicalCoreDevice);
  mockIsProcessAlive.mockReturnValue(true);
  process.env.AGENT_DEVICE_IOS_RUNNER_DETACH = '0';

  expect(await tryAdoptRunnerSessionFromLease(physicalCoreDevice, {})).toBeNull();
  expect(mockSendRunnerCommandOnce).not.toHaveBeenCalled();
});
