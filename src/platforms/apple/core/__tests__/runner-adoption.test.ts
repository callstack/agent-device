import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  buildDetachedRunnerLease,
  buildRunnerLease,
  readStaleRunnerLease,
  RUNNER_OWNER_START_TIME,
  writeRunnerLease,
  type RunnerLease,
} from '../runner/runner-lease.ts';
import {
  isIosRunnerDetachEnabled,
  tryAdoptRunnerSessionFromLease,
} from '../runner/runner-adoption.ts';
import { sendRunnerCommandOnce } from '../runner/runner-transport.ts';
import {
  isProcessAlive,
  readProcessCommand,
  readProcessStartTime,
} from '../../../../utils/host-process.ts';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';

vi.mock('../runner/runner-transport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner/runner-transport.ts')>();
  return { ...actual, sendRunnerCommandOnce: vi.fn() };
});
vi.mock('../../../../utils/host-process.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../utils/host-process.ts')>();
  return {
    ...actual,
    isProcessAlive: vi.fn(() => false),
    readProcessCommand: vi.fn(() => null),
    readProcessStartTime: vi.fn(() => 'test-process-start'),
  };
});
vi.mock('../runner/runner-xctestrun.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner/runner-xctestrun.ts')>();
  return {
    ...actual,
    resolveExpectedRunnerCacheMetadata: vi.fn(() => ({})),
    resolveRunnerDerivedPath: vi.fn(() => expectedDerived),
  };
});

const mockSendRunnerCommandOnce = vi.mocked(sendRunnerCommandOnce);
const mockIsProcessAlive = vi.mocked(isProcessAlive);
const mockReadProcessCommand = vi.mocked(readProcessCommand);
const mockReadProcessStartTime = vi.mocked(readProcessStartTime);

const simulator: DeviceInfo = {
  platform: 'apple',
  id: 'adopt-sim-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

let leaseDir: string;
let expectedDerived: string;

function writeStaleLease(overrides: Partial<RunnerLease> = {}): RunnerLease {
  const lease: RunnerLease = {
    ...buildRunnerLease({
      deviceId: simulator.id,
      sessionId: `${simulator.id}:50700:1`,
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
      deviceId: simulator.id,
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
  expect(session?.ready).toBe(true);
  expect(session?.child.pid).toBe(424242);
  expect(session?.xctestrunArtifact?.reason).toBe('adopted_from_lease');
  // Adoption transfers ownership: the lease on disk now belongs to us.
  expect(readStaleRunnerLease(simulator.id)).toBeNull();
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

  expect(session?.ready).toBe(true);
  expect(session?.child.pid).toBe(424242);
});

test('adoption is skipped for devices in a custom simulator set', async () => {
  writeStaleLease();
  mockIsProcessAlive.mockReturnValue(true);

  const scopedDevice = { ...simulator, simulatorSetPath: '/custom/device-set' };
  expect(await tryAdoptRunnerSessionFromLease(scopedDevice, {})).toBeNull();
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
    ownerStartTime: RUNNER_OWNER_START_TIME,
    ownerStateDir: goneStateDir,
  });
  mockIsProcessAlive.mockReturnValue(true);

  expect(readStaleRunnerLease(simulator.id)).toBeNull();
  expect(await tryAdoptRunnerSessionFromLease(simulator, {})).toBeNull();
  expect(mockSendRunnerCommandOnce).not.toHaveBeenCalled();
});
