import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '../../../../kernel/device.ts';
import {
  buildDetachedRunnerLease,
  buildRunnerLease,
  readStaleRunnerLease,
  writeRunnerLease,
  type RunnerLease,
} from '../runner/runner-lease.ts';
import {
  isIosRunnerDetachEnabled,
  tryAdoptRunnerSessionFromLease,
} from '../runner/runner-adoption.ts';
import { sendRunnerCommandOnce } from '../runner/runner-transport.ts';
import { isProcessAlive } from '../../../../utils/process-identity.ts';
import {
  resolveExpectedRunnerCacheMetadata,
  resolveRunnerDerivedPath,
} from '../runner/runner-xctestrun.ts';

vi.mock('../runner/runner-transport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner/runner-transport.ts')>();
  return { ...actual, sendRunnerCommandOnce: vi.fn() };
});
vi.mock('../../../../utils/process-identity.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../utils/process-identity.ts')>();
  return { ...actual, isProcessAlive: vi.fn(() => false) };
});

const mockSendRunnerCommandOnce = vi.mocked(sendRunnerCommandOnce);
const mockIsProcessAlive = vi.mocked(isProcessAlive);

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
  leaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-lease-test-'));
  process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = leaseDir;
  expectedDerived = resolveRunnerDerivedPath(
    simulator,
    resolveExpectedRunnerCacheMetadata(simulator),
  );
  mockSendRunnerCommandOnce.mockReset();
  mockIsProcessAlive.mockReset();
  mockIsProcessAlive.mockReturnValue(false);
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
