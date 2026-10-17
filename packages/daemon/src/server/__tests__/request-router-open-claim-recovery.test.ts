import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import {
  canonicalLocalDeviceKey,
  inspectDeviceClaims,
} from '@agent-device/daemon-contracts/device-claims';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { deviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import {
  createRequestHandler,
  lifecycleDeviceRuntimeGateway,
} from '../../__tests__/support/test-device-runtime-gateway.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { unavailableDeviceRuntimeGateway } from '../../__tests__/support/unavailable-device-runtime-gateway.ts';
import { getResolveTargetDeviceMock } from '../../__tests__/support/request-router-dispatch-mocks.ts';
import { makeIosDevice, openRequest } from './request-router-open-harness.ts';
import { mkdtempForTestSync, createTestHostEnvironment } from '@agent-device/test-kit';

const mockResolveTargetDevice = vi.mocked(getResolveTargetDeviceMock());

beforeEach(() => {
  mockResolveTargetDevice.mockReset();
});

test('open composes claim recovery from the foreign owner state directory', async () => {
  const device = { ...makeIosDevice('SIM-FOREIGN-RECOVERY'), appleOs: 'ios' as const };
  mockResolveTargetDevice.mockResolvedValue(device);
  const claimsDir = mkdtempForTestSync('agent-device-open-claims-');
  const foreignStateDir = mkdtempForTestSync('agent-device-open-foreign-');
  const sessionStore = makeSessionStore('agent-device-open-recovery-');
  const previousClaimsDir = process.env.AGENT_DEVICE_CLAIMS_DIR;
  process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;
  const recoverySessionDirs: string[] = [];
  const composeClaimRecovery = (input: { sessionsDir: string }) => {
    recoverySessionDirs.push(input.sessionsDir);
    return unavailableDeviceRuntimeGateway;
  };

  try {
    writeForeignClaim(claimsDir, foreignStateDir, device);
    const handler = createRequestHandler({
      host: createTestHostEnvironment(),
      createCommandSurface: fakeCreateCommandSurface,
      logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
      token: 'test-token',
      sessionStore,
      leaseRegistry: new LeaseRegistry(),
      deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
      claimRecoveryGateway: composeClaimRecovery,
      deviceInventoryGateways: createTestDeviceInventoryGateways(),
      trackDownloadableArtifact: () => 'artifact-id',
    });

    const response = await handler(
      openRequest('takeover', { platform: 'ios' }, 'req-open-foreign-recovery'),
    );

    expect(response.ok).toBe(true);
    const ownerSessionsDir = resolveDaemonPaths(foreignStateDir).sessionsDir;
    const daemonSessionsDir = resolveDaemonPaths(sessionStore.resolveDaemonStateDir()).sessionsDir;
    expect(recoverySessionDirs).toEqual([ownerSessionsDir]);
    expect(recoverySessionDirs[0]).not.toBe(daemonSessionsDir);
    expect(inspectDeviceClaims({ udid: device.id }, process.env)[0]?.claim?.session).toBe(
      'takeover',
    );
  } finally {
    if (previousClaimsDir === undefined) delete process.env.AGENT_DEVICE_CLAIMS_DIR;
    else process.env.AGENT_DEVICE_CLAIMS_DIR = previousClaimsDir;
    fs.rmSync(claimsDir, { recursive: true, force: true });
    fs.rmSync(foreignStateDir, { recursive: true, force: true });
  }
});

function writeForeignClaim(claimsDir: string, stateDir: string, device: DeviceInfo): void {
  const deviceKey = canonicalLocalDeviceKey(device);
  const claimPath = path.join(
    claimsDir,
    `${crypto.createHash('sha256').update(deviceKey).digest('hex')}.json`,
  );
  fs.writeFileSync(
    claimPath,
    JSON.stringify({
      schemaVersion: 2,
      deviceKey,
      device: { ...deviceIdentity(device), name: device.name },
      session: 'shared',
      workspace: '/worktrees/dead',
      stateDir,
      ownerPid: 999_999_999,
      ownerStartTime: 'old-start-time',
      ownerToken: 'open-recovery-token',
      createdAtMs: 1,
      updatedAtMs: 1,
    }),
  );
}
