import { test, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fakeCreateCommandSurface } from '@agent-device/daemon/testing/__tests__/support/command-surface-fake';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import {
  composedClaimRecoveryGatewayFixture,
  composedPlatformServicesFixture,
} from './platform-services-fixture.ts';
import { getResolveTargetDeviceMock } from '@agent-device/daemon/testing/__tests__/request-router-dispatch-mocks';
import { LeaseRegistry } from '@agent-device/daemon/testing/lease-registry';
import type { DeviceInfo } from '@agent-device/kernel/device';

// Open-time claim reconciliation runs on the root-composed claim-recovery gateway: the router
// must hand the acquire path the OWNER-scoped reconciler, so a foreign dead owner's recording
// recovery executes against that owner's state dir, never the daemon's own store (#2168).

vi.mock('@agent-device/daemon/testing/device/device-ready', () => ({
  ensureDeviceReady: vi.fn(async () => {}),
}));
vi.mock('@agent-device/host-kit/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/process')>();
  const startTime = 'test-process-start';
  return {
    ...actual,
    readProcessStartTime: vi.fn(() => startTime),
    // The ownership decision reads all three facts in one call, so it has to answer with the
    // same fabricated start time this fixture writes into its markers.
    readProcessIdentityFacts: vi.fn(async (pid: number) => ({
      startTime,
      command: actual.readProcessCommand(pid),
      zombie: false,
    })),
  };
});
vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>();
  return {
    ...actual,
    detachIosRunnerSessionsForShutdown: vi.fn(async () => {}),
    notifyIosRunnerAppRelaunched: vi.fn(async () => {}),
    prewarmAppleRunnerCache: vi.fn(async () => {}),
    prewarmIosRunnerSession: vi.fn(async () => {}),
    prepareIosRunner: vi.fn(async () => ({
      runner: { currentUptimeMs: 42 },
      connectMs: 0,
      healthCheckMs: 0,
    })),
    resolveRunnerAppBundleId: vi.fn(() => 'com.callstack.agentdevice.runner'),
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

import {
  createRequestHandler,
  lifecycleDeviceRuntimeGateway,
} from '@agent-device/daemon/testing/__tests__/test-device-runtime-gateway';
import {
  awaitFixtureReadiness,
  dispatchApplicationLifecycleEffect,
} from '@agent-device/daemon/testing/__tests__/application-lifecycle-runtime-fixture';
import { discoverReadyAndroidEmulators } from './application-lifecycle-runtime-fixture.ts';
import { makeSessionStore } from '@agent-device/daemon/testing/__tests__/support/store-factory';
import { inspectDeviceClaims } from '@agent-device/daemon-contracts/device-claims';
import {
  createOwnedProcessRecordStore,
  isProcessAlive,
  readProcessCommand,
  readProcessStartTime,
} from '@agent-device/host-kit/process';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { screenRecordingDurableResource } from '@agent-device/capture-kit/screen-recording-session-resource';
import {
  makeIosDevice,
  openRequest,
} from '@agent-device/daemon/testing/__tests__/request-router-open-harness';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';

const mockResolveTargetDevice = vi.mocked(getResolveTargetDeviceMock());
const mockDispatch = vi.mocked(dispatchApplicationLifecycleEffect);
const mockDiscoverReadyAndroidEmulators = vi.mocked(discoverReadyAndroidEmulators);
const mockAwaitFixtureReadiness = vi.mocked(awaitFixtureReadiness);

function createOpenHandler(sessionStore: ReturnType<typeof makeSessionStore>) {
  return createRequestHandler({
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    platformServices: composedPlatformServicesFixture(),
    claimRecoveryGateway: composedClaimRecoveryGatewayFixture(),
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
  });
}

beforeEach(() => {
  mockResolveTargetDevice.mockReset();
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue(undefined);
  mockAwaitFixtureReadiness.mockReset();
  mockAwaitFixtureReadiness.mockResolvedValue(undefined);
  mockDiscoverReadyAndroidEmulators.mockReset();
});

// The dead owner's recorded recorder must still run as an orphan: recovery
// then takes the descriptor-cleanup path — the one that terminates it and
// clears the owned-process store it was composed with. A plain sleeper with
// its real observed command and start time satisfies the exact match. The
// sleeper is the current Node binary on a parked timer, so the case runs on
// every platform (`sleep` is not a Windows command).
async function spawnOrphanRecorder() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120_000)'], {
    stdio: 'ignore',
  });
  await new Promise((resolve) => child.once('spawn', resolve));
  const pid = child.pid ?? 0;
  const marker = {
    pid,
    startTime: readProcessStartTime(pid) ?? '',
    command: readProcessCommand(pid) ?? '',
  };
  expect(pid).toBeGreaterThan(0);
  expect(marker.startTime.length).toBeGreaterThan(0);
  expect(marker.command.length).toBeGreaterThan(0);
  return { child, marker };
}

function ownedStoreFor(stateDir: string) {
  const paths = resolveDaemonPaths(stateDir);
  return createOwnedProcessRecordStore({
    stateDir: paths.baseDir,
    sessionsDir: paths.sessionsDir,
    resolveSessionDir: (sessionId) => path.join(paths.sessionsDir, sessionId),
  });
}

function seedForeignRecordingOwner(
  foreignStateDir: string,
  device: DeviceInfo,
  marker: { pid: number; startTime: string; command: string },
) {
  const foreignSessionDir = path.join(resolveDaemonPaths(foreignStateDir).sessionsDir, 'shared');
  const resourcePath = screenRecordingDurableResource.store.resolvePath(foreignSessionDir);
  screenRecordingDurableResource.store.write(
    resourcePath,
    createDurableResourceEnvelope({
      resourceKind: 'screen-recording',
      sessionId: 'shared',
      device: { id: device.id, family: 'apple', appleOs: 'ios', kind: 'simulator' },
      owner: { kind: 'local-family', family: 'apple' },
      fence: { token: 'open-recovery-fence', generation: 1 },
      lifecycle: 'open',
      descriptor: {
        version: 1,
        body: {
          backend: 'simctl',
          outputPath: path.join(foreignSessionDir, 'recording.mp4'),
          processes: [marker],
        },
      },
    }),
  );
  ownedStoreFor(foreignStateDir).replace({ kind: 'session', sessionId: 'shared' }, [
    { ...marker, purpose: 'simctl-screen-recording' },
  ]);
  return { foreignSessionDir, resourcePath };
}

function seedDeadForeignClaim(claimsDir: string, device: DeviceInfo, foreignStateDir: string) {
  const deviceKey = `local:apple:ios:${device.id}`;
  fs.writeFileSync(
    path.join(claimsDir, `${crypto.createHash('sha256').update(deviceKey).digest('hex')}.json`),
    JSON.stringify({
      schemaVersion: 1,
      deviceKey,
      device: { platform: 'ios', id: device.id, name: device.name, kind: 'simulator' },
      session: 'shared',
      workspace: '/worktrees/dead',
      stateDir: foreignStateDir,
      ownerPid: 999_999_999,
      ownerStartTime: 'old-start-time',
      ownerToken: 'open-recovery-token',
      createdAtMs: 1,
      updatedAtMs: 1,
    }),
  );
}

test('open reconciles a foreign dead owner through that owner state dir, never the daemon store', async () => {
  // #2168 acquire-path wiring: the router must hand open-time claim
  // reconciliation the owner-scoped reconciler. With the caller-scoped
  // reconciler this test goes red — the foreign recording recovery runs
  // against the daemon's own gateway and store instead of the dead owner's.
  const sessionStore = makeSessionStore('agent-device-router-open-recovery-');
  const device = makeIosDevice('SIM-FOREIGN-RECOVERY');
  mockResolveTargetDevice.mockResolvedValue(device);
  const claimsDir = mkdtempForTestSync('agent-device-router-open-claims-');
  const foreignStateDir = mkdtempForTestSync('agent-device-router-open-foreign-');
  const previousClaimsDir = process.env.AGENT_DEVICE_CLAIMS_DIR;
  process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;
  const orphan = await spawnOrphanRecorder();

  try {
    const { foreignSessionDir, resourcePath } = seedForeignRecordingOwner(
      foreignStateDir,
      device,
      orphan.marker,
    );
    const daemonStateDir = sessionStore.resolveDaemonStateDir();
    ownedStoreFor(daemonStateDir).replace({ kind: 'session', sessionId: 'shared' }, [
      { pid: process.pid, startTime: 'live-marker', command: 'live-probe', purpose: 'test-probe' },
    ]);
    const liveRecordPath = path.join(
      resolveDaemonPaths(daemonStateDir).sessionsDir,
      'shared',
      'owned-processes.json',
    );
    const liveRecordBefore = fs.readFileSync(liveRecordPath, 'utf8');
    seedDeadForeignClaim(claimsDir, device, foreignStateDir);

    const response = await createOpenHandler(sessionStore)(
      openRequest('takeover', { platform: 'ios' }, 'req-open-foreign-recovery'),
    );

    expect(response.ok).toBe(true);
    const settled = screenRecordingDurableResource.store.read(resourcePath);
    expect(settled).toMatchObject({ status: 'decoded', envelope: { lifecycle: 'completed' } });
    expect(fs.existsSync(path.join(foreignSessionDir, 'owned-processes.json'))).toBe(false);
    expect(fs.readFileSync(liveRecordPath, 'utf8')).toBe(liveRecordBefore);
    expect(isProcessAlive(orphan.marker.pid)).toBe(false);
    expect(inspectDeviceClaims({ udid: device.id })[0]?.claim?.session).toBe('takeover');
  } finally {
    try {
      orphan.child.kill('SIGKILL');
    } catch {
      // The orphan is already gone once recovery terminated it.
    }
    if (previousClaimsDir === undefined) delete process.env.AGENT_DEVICE_CLAIMS_DIR;
    else process.env.AGENT_DEVICE_CLAIMS_DIR = previousClaimsDir;
    fs.rmSync(claimsDir, { recursive: true, force: true });
    fs.rmSync(foreignStateDir, { recursive: true, force: true });
  }
});
