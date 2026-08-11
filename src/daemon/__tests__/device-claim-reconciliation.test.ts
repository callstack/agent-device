import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import {
  localRuntimeOwner,
  type DeviceRuntimeGateway,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform';
import { createTestAppLogLiveHandle } from '../../__tests__/test-utils/app-log-live-handle.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { createDeviceClaimReconciler } from '../device-claim-reconciliation.ts';
import type { DeviceClaim } from '../device-claims.ts';
import { appLogResourceStore } from '../app-log-resource-store.ts';

const scope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => {} },
  progress: { report: () => {} },
};

test('reconciles the dead owner session resources through their exact runtime owner', async () => {
  const stateDir = mkdtempForTestSync('device-claim-reconcile-');
  const claim = makeClaim(stateDir);
  const resourcePath = appLogResourceStore.resolvePath(
    path.join(stateDir, 'sessions', claim.session),
  );
  appLogResourceStore.write(
    resourcePath,
    createDurableResourceEnvelope({
      resourceKind: 'app-log',
      sessionId: claim.session,
      device: { id: claim.device.id, family: 'android', kind: 'emulator' },
      owner: localRuntimeOwner('android'),
      fence: { token: 'fence', generation: 1 },
      lifecycle: 'open',
      descriptor: { version: 1, body: { pid: 123 } },
    }),
  );
  const forceCleanup = vi.fn(async () => ({ status: 'cleaned' as const }));
  const handle = createTestAppLogLiveHandle({
    inspect: () => ({ backend: 'android', state: 'recovering', startedAt: 1 }),
    finish: async () => ({
      status: 'completed',
      result: { backend: 'android', outputPath: '/tmp/app.log', completedAt: 2 },
    }),
    forceCleanup,
  });
  const bind = vi.fn(async ({ device }) => ({
    device,
    owner: localRuntimeOwner('android'),
    facts: {
      device: { family: 'android' as const, kind: device.kind, providerMode: 'local' as const },
      operations: {
        appLogInspect: unavailable,
        appLogDoctor: unavailable,
        appLogStart: unavailable,
        appLogReattach: { available: true as const },
        appLogCleanup: { available: true as const },
        networkDump: unavailable,
        screenRecordingStart: unavailable,
        screenRecordingReattach: unavailable,
        screenRecordingCleanup: unavailable,
        ensureReady: unavailable,
        bootTarget: unavailable,
        bootTargetHeadless: unavailable,
        listApps: unavailable,
      },
    },
    operations: {
      appLogReattach: async () => ({ status: 'active' as const, handle }),
      appLogCleanup: async () => ({ status: 'cleaned' as const }),
    },
    [Symbol.asyncDispose]: async () => {},
  }));
  const gateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
    inspectFacts: async () => {
      throw new Error('unused');
    },
    bind,
    shutdown: async () => {},
  };

  await expect(createDeviceClaimReconciler({ gateway, scope })(claim)).resolves.toEqual({
    status: 'reconciled',
  });
  expect(bind).toHaveBeenCalledWith(
    expect.objectContaining({
      intent: {
        kind: 'exact-owner',
        owner: localRuntimeOwner('android'),
        fence: { token: 'fence', generation: 1 },
      },
    }),
  );
  expect(forceCleanup).toHaveBeenCalledOnce();
  expect(appLogResourceStore.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed' },
  });
});

test('unreattachable resource evidence retains the claim without binding', async () => {
  const stateDir = mkdtempForTestSync('device-claim-reconcile-invalid-');
  const claim = makeClaim(stateDir);
  const resourcePath = appLogResourceStore.resolvePath(
    path.join(stateDir, 'sessions', claim.session),
  );
  fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
  fs.writeFileSync(resourcePath, '{');
  const bind = vi.fn();
  const gateway = {
    bind,
    shutdown: async () => {},
  } as unknown as DeviceRuntimeGateway<PlatformRuntimeOperations>;

  await expect(createDeviceClaimReconciler({ gateway, scope })(claim)).resolves.toEqual({
    status: 'retained',
    reason: 'app-log-descriptor-invalid',
  });
  expect(bind).not.toHaveBeenCalled();
  expect(fs.readFileSync(resourcePath, 'utf8')).toBe('{');
});

const unavailable = Object.freeze({
  available: false as const,
  reason: 'owner-capability-missing' as const,
});

function makeClaim(stateDir: string): DeviceClaim {
  return {
    schemaVersion: 2,
    deviceKey: 'local:android:none:emulator-5554',
    device: { family: 'android', id: 'emulator-5554', name: 'Pixel', kind: 'emulator' },
    session: 'claimed-session',
    workspace: '/worktrees/dead',
    stateDir,
    ownerPid: 999_999_999,
    ownerStartTime: 'dead-start',
    ownerToken: 'claim-token',
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}
