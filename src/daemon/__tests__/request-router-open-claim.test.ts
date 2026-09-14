import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import { test, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { getResolveTargetDeviceMock } from './request-router-dispatch-mocks.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

vi.mock('../device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));
vi.mock('@agent-device/host-kit/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/process')>();
  return { ...actual, readProcessStartTime: vi.fn(() => 'test-process-start') };
});
vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>();
  return {
    ...actual,
    detachIosSimulatorRunnerSessionsForShutdown: vi.fn(async () => {}),
    notifyIosRunnerAppRelaunched: vi.fn(async () => {}),
    prewarmAppleRunnerCache: vi.fn(async () => {}),
    prewarmIosRunner: vi.fn(async () => {}),
    prepareIosRunner: vi.fn(async () => ({
      runner: { currentUptimeMs: 42 },
      connectMs: 0,
      healthCheckMs: 0,
    })),
    resolveRunnerAppBundleId: vi.fn(() => 'com.callstack.agentdevice.runner'),
    scheduleIosRunnerIdleStop: vi.fn(),
    stopIosRunnerSession: vi.fn(async () => {}),
    stopAllIosRunnerSessions: vi.fn(async () => {}),
  };
});
vi.mock('@agent-device/platform-apple/app-lifecycle', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/app-lifecycle')>();
  return { ...actual, closeIosApp: vi.fn(async () => {}) };
});
vi.mock('@agent-device/platform-apple/app-resolution', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/app-resolution')>();
  return {
    ...actual,
    resolveIosApp: vi.fn(async (_device, app) => app),
  };
});
// Claim settlement asks the device when its current boot began; these tests answer by hand rather
// than reading the host's real process table.
const mockObserveSimulatorBoot = vi.hoisted(() =>
  vi.fn(async (): Promise<DeviceBootObservation> => ({
    observed: false,
    reason: 'unobserved',
  })),
);
vi.mock('@agent-device/platform-apple/simulator-boot', () => ({
  observeSimulatorBootTimeMs: mockObserveSimulatorBoot,
}));

import {
  createRequestHandler,
  lifecycleDeviceRuntimeGateway,
} from './test-device-runtime-gateway.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import {
  awaitFixtureReadiness,
  discoverReadyAndroidEmulators,
} from './application-lifecycle-runtime-fixture.ts';
import { ensureDeviceReady } from '../device-ready.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DeviceBootObservation } from '@agent-device/contracts/device-boot';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { inspectDeviceClaims } from '../device-claim-inspection.ts';
import { makeIosDevice, openRequest, storedClaimUpdatedAt } from './request-router-open-harness.ts';

const mockResolveTargetDevice = vi.mocked(getResolveTargetDeviceMock());
const mockEnsureDeviceReady = vi.mocked(ensureDeviceReady);
const mockDiscoverReadyAndroidEmulators = vi.mocked(discoverReadyAndroidEmulators);
const mockAwaitFixtureReadiness = vi.mocked(awaitFixtureReadiness);

function createOpenHandler(
  sessionStore: ReturnType<typeof makeSessionStore>,
  leaseRegistry = new LeaseRegistry(),
) {
  return createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry,
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
  });
}

beforeEach(() => {
  mockResolveTargetDevice.mockReset();
  mockEnsureDeviceReady.mockReset();
  mockEnsureDeviceReady.mockResolvedValue(undefined);
  mockAwaitFixtureReadiness.mockReset();
  mockAwaitFixtureReadiness.mockResolvedValue(undefined);
  mockObserveSimulatorBoot.mockReset();
  mockObserveSimulatorBoot.mockImplementation(async () => ({
    observed: false,
    reason: 'unobserved',
  }));
  mockDiscoverReadyAndroidEmulators.mockReset();
});

function seedLiveForeignClaim(claimsDir: string, device: DeviceInfo, foreignStateDir: string) {
  const deviceKey = `local:apple:ios:${device.id}`;
  fs.writeFileSync(
    path.join(claimsDir, `${crypto.createHash('sha256').update(deviceKey).digest('hex')}.json`),
    JSON.stringify({
      schemaVersion: 2,
      deviceKey,
      device: {
        family: 'apple',
        appleOs: 'ios',
        id: device.id,
        name: device.name,
        kind: 'simulator',
      },
      session: 'shared',
      workspace: '/worktrees/live',
      stateDir: foreignStateDir,
      ownerPid: process.ppid,
      ownerStartTime: 'test-process-start',
      ownerToken: 'reboot-takeover-token',
      createdAtMs: 1,
      updatedAtMs: 1,
    }),
  );
}

test('open takes a live foreign claim whose device rebooted after the claim was taken', async () => {
  // #2538: host-global claims outlive a device reboot while the claiming daemon stays alive, so
  // the device's own boot is the only ownership proof that does, and `open` says what it released.
  const sessionStore = makeSessionStore('agent-device-router-open-reboot-');
  const device = makeIosDevice('SIM-REBOOTED');
  mockResolveTargetDevice.mockResolvedValue(device);
  const claimsDir = mkdtempForTestSync('agent-device-router-open-reboot-claims-');
  const foreignStateDir = mkdtempForTestSync('agent-device-router-open-reboot-foreign-');
  const previousClaimsDir = process.env.AGENT_DEVICE_CLAIMS_DIR;
  process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;
  const bootedAtMs = Date.now();
  mockObserveSimulatorBoot.mockResolvedValueOnce({ observed: true, bootedAtMs });

  try {
    seedLiveForeignClaim(claimsDir, device, foreignStateDir);

    const response = await createOpenHandler(sessionStore)(
      openRequest('reboot-takeover', { platform: 'ios' }, 'req-open-reboot-takeover'),
    );

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(mockObserveSimulatorBoot).toHaveBeenCalledWith(device);
    expect(response.data?.warnings).toContain(
      'Took the device from session "shared" in workspace "/worktrees/live": that device rebooted after its claim was taken, so its app and runner were already gone.',
    );
    expect(inspectDeviceClaims({ udid: device.id })[0]?.claim?.session).toBe('reboot-takeover');
  } finally {
    if (previousClaimsDir === undefined) delete process.env.AGENT_DEVICE_CLAIMS_DIR;
    else process.env.AGENT_DEVICE_CLAIMS_DIR = previousClaimsDir;
    fs.rmSync(claimsDir, { recursive: true, force: true });
    fs.rmSync(foreignStateDir, { recursive: true, force: true });
  }
});

// The production reopen path never re-acquires the claim, so renewal has to ride the successful
// existing-session open itself: without it, an owner that came back after a reboot still carries a
// pre-reboot stamp and loses the device to the next caller that asks.
test('open renews the claim of an existing session that reopened its app after a reboot', async () => {
  const sessionStore = makeSessionStore('agent-device-router-open-renew-');
  const device = makeIosDevice('SIM-RENEWED');
  mockResolveTargetDevice.mockResolvedValue(device);
  const claimsDir = mkdtempForTestSync('agent-device-router-open-renew-claims-');
  const previousClaimsDir = process.env.AGENT_DEVICE_CLAIMS_DIR;
  process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;

  try {
    const opened = await createOpenHandler(sessionStore)(
      openRequest('renew-owner', { platform: 'ios' }, 'req-open-renew-owner', {}, ['FixtureApp']),
    );
    expect(opened.ok).toBe(true);
    const claimedAtMs = storedClaimUpdatedAt(device);
    await new Promise((resolve) => setTimeout(resolve, 2));

    const reopened = await createOpenHandler(sessionStore)(
      openRequest('renew-owner', { platform: 'ios' }, 'req-open-renew-reopen', {}, ['FixtureApp']),
    );
    expect(reopened.ok).toBe(true);
    expect(storedClaimUpdatedAt(device)).toBeGreaterThan(claimedAtMs);

    mockObserveSimulatorBoot.mockResolvedValueOnce({
      observed: true,
      bootedAtMs: claimedAtMs + 1,
    });
    const foreign = await createOpenHandler(sessionStore)(
      openRequest('renew-foreign', { platform: 'ios' }, 'req-open-renew-foreign', {}, [
        'FixtureApp',
      ]),
    );

    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.error.code).toBe('DEVICE_IN_USE');
    expect(inspectDeviceClaims({ udid: device.id })[0]?.claim?.session).toBe('renew-owner');
  } finally {
    if (previousClaimsDir === undefined) delete process.env.AGENT_DEVICE_CLAIMS_DIR;
    else process.env.AGENT_DEVICE_CLAIMS_DIR = previousClaimsDir;
    fs.rmSync(claimsDir, { recursive: true, force: true });
  }
});

// The renewal is the owner's check that it still holds the device, and it runs before any device
// work: a foreign daemon that took the device mid-reopen must produce a refusal, not a successful
// launch on a device this session no longer owns.
test('an owner reopen that lost the device mid-flight reports the loss instead of launching', async () => {
  const sessionStore = makeSessionStore('agent-device-router-open-race-');
  const device = makeIosDevice('SIM-RACED');
  mockResolveTargetDevice.mockResolvedValue(device);
  const claimsDir = mkdtempForTestSync('agent-device-router-open-race-claims-');
  const foreignStateDir = mkdtempForTestSync('agent-device-router-open-race-foreign-');
  const previousClaimsDir = process.env.AGENT_DEVICE_CLAIMS_DIR;
  process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;

  try {
    const opened = await createOpenHandler(sessionStore)(
      openRequest('race-owner', { platform: 'ios' }, 'req-open-race-owner', {}, ['FixtureApp']),
    );
    expect(opened.ok).toBe(true);

    seedLiveForeignClaim(claimsDir, device, foreignStateDir);

    const reopened = await createOpenHandler(sessionStore)(
      openRequest('race-owner', { platform: 'ios' }, 'req-open-race-reopen', {}, ['FixtureApp']),
    );

    expect(reopened.ok).toBe(false);
    if (!reopened.ok) {
      expect(reopened.error.code).toBe('DEVICE_IN_USE');
      expect(reopened.error.message).toContain('shared');
    }
    expect(inspectDeviceClaims({ udid: device.id })[0]?.claim?.ownerToken).toBe(
      'reboot-takeover-token',
    );
  } finally {
    if (previousClaimsDir === undefined) delete process.env.AGENT_DEVICE_CLAIMS_DIR;
    else process.env.AGENT_DEVICE_CLAIMS_DIR = previousClaimsDir;
    fs.rmSync(claimsDir, { recursive: true, force: true });
    fs.rmSync(foreignStateDir, { recursive: true, force: true });
  }
});
