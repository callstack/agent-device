import { createDeviceClaimReconciler } from './device-claim-reconciliation.ts';
import { inspectDeviceClaimRecovery } from '@agent-device/daemon-contracts/device-claim-recovery';
import { appLogResourceStore } from '@agent-device/capture-kit/app-log-durable-resource';
import { audioProbeDurableResource } from '@agent-device/capture-kit/audio-probe-session-resource';
import { perfCaptureDurableResource } from '@agent-device/capture-kit/perf-capture-session-resource';
import { screenRecordingDurableResource } from '@agent-device/capture-kit/screen-recording-session-resource';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { applicationLifecycleOperationFacts } from '@agent-device/contracts/application-lifecycle-runtime';
import {
  type DeviceRuntimeGateway,
  localRuntimeOwner,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import {
  createTestAppLogLiveHandle,
  mkdtempForTestSync,
  unavailableDeploymentSnapshotAndShutdownOperationFacts,
} from '@agent-device/test-kit';
import type { DeviceClaim } from './device-claims.ts';
import { resolveDeviceClaimPath } from './device-claim-paths.ts';
import { settleVerifiedOrphanedClaim } from './device-claim-settlement.ts';
import { writeDeviceClaim } from './device-claim-store.ts';
import { createOwnerScopedDeviceClaimReconciler } from './device-claim-owner-recovery.ts';

const scope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => {} },
  progress: { report: () => {} },
};

test.each([
  {
    caseName: 'cleaned',
    cleanup: { status: 'cleaned' as const },
    result: { status: 'reconciled' as const },
    lifecycle: 'completed',
  },
  {
    caseName: 'cleanup pending',
    cleanup: { status: 'cleanup-pending' as const, reason: 'cleanup-unconfirmed' as const },
    result: { status: 'retained' as const, reason: 'app-log-cleanup-pending' },
    lifecycle: 'open',
  },
])(
  'dead owner app-log $caseName preserves exact-owner recovery',
  async ({ cleanup, result, lifecycle }) => {
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
    const forceCleanup = vi.fn(async () => cleanup);
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
          appState: unavailable,
          networkDump: unavailable,
          networkCaptureStart: unavailable,
          networkCaptureStop: unavailable,
          screenRecordingStart: unavailable,
          screenRecordingReattach: unavailable,
          screenRecordingCleanup: unavailable,
          ensureReady: unavailable,
          bootTarget: unavailable,
          bootTargetHeadless: unavailable,
          listApps: unavailable,
          ...unavailableDeploymentSnapshotAndShutdownOperationFacts,
          ...applicationLifecycleOperationFacts({
            resolveOpenTarget: unavailable,
            prepareApplicationOpen: unavailable,
            openApplication: unavailable,
            applyRuntimeHints: unavailable,
            clearRuntimeHints: unavailable,
            closeApplication: unavailable,
            finalizeApplicationClose: unavailable,
            prepareAppleRunner: unavailable,
            configureProviderPortReverse: unavailable,
          }),
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

    const before = fs.readFileSync(resourcePath);
    expect(inspectDeviceClaimRecovery(claim)).toEqual({
      status: 'inspectable',
      recoveryKinds: ['app-log'],
      ownedResources: [{ resourceKind: 'app-log', resourcePath }],
    });
    expect(bind).not.toHaveBeenCalled();
    expect(fs.readFileSync(resourcePath)).toEqual(before);

    await expect(createDeviceClaimReconciler({ gateway, scope })(claim)).resolves.toEqual(result);
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
      envelope: { lifecycle },
    });
  },
);

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

  expect(inspectDeviceClaimRecovery(claim)).toEqual({
    status: 'retained',
    reason: 'app-log-descriptor-invalid',
  });

  await expect(createDeviceClaimReconciler({ gateway, scope })(claim)).resolves.toEqual({
    status: 'retained',
    reason: 'app-log-descriptor-invalid',
  });
  expect(bind).not.toHaveBeenCalled();
  expect(fs.readFileSync(resourcePath, 'utf8')).toBe('{');
});

const resourceStores = [
  { kind: 'app-log', store: appLogResourceStore },
  { kind: 'screen-recording', store: screenRecordingDurableResource.store },
  { kind: 'audio-probe', store: audioProbeDurableResource.store },
  { kind: 'perf-capture', store: perfCaptureDurableResource.store },
] as const;

test.each(
  resourceStores.flatMap(({ kind, store }) => [
    { kind, store, evidence: 'unreadable' as const, reason: `${kind}-descriptor-invalid` },
    {
      kind,
      store,
      evidence: 'unknown-version' as const,
      reason: `${kind}-descriptor-version-unsupported`,
    },
    { kind, store, evidence: 'mismatched-owner' as const, reason: `${kind}-owner-mismatch` },
  ]),
)(
  '$kind $evidence retains the claim before recovery',
  async ({ kind, store, evidence, reason }) => {
    const stateDir = mkdtempForTestSync('device-claim-resource-owner-');
    const claim = makeClaim(stateDir);
    const resourcePath = store.resolvePath(path.join(stateDir, 'sessions', claim.session));
    const envelope = createDurableResourceEnvelope({
      resourceKind: kind,
      sessionId: evidence === 'mismatched-owner' ? 'another-session' : claim.session,
      device: claim.device,
      owner: localRuntimeOwner('android'),
      fence: { token: 'fence', generation: 1 },
      lifecycle: 'open',
      descriptor: { version: 1, body: {} },
    });
    const contents =
      evidence === 'unreadable'
        ? '{'
        : JSON.stringify(
            evidence === 'unknown-version' ? { ...envelope, envelopeVersion: 99 } : envelope,
          );
    fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
    fs.writeFileSync(resourcePath, contents);
    const bind = vi.fn();
    const gateway = {
      bind,
      shutdown: async () => {},
    } as unknown as DeviceRuntimeGateway<PlatformRuntimeOperations>;

    expect(inspectDeviceClaimRecovery(claim)).toEqual({ status: 'retained', reason });
    await expect(createDeviceClaimReconciler({ gateway, scope })(claim)).resolves.toEqual({
      status: 'retained',
      reason,
    });
    expect(bind).not.toHaveBeenCalled();
    expect(fs.readFileSync(resourcePath, 'utf8')).toBe(contents);
  },
);

const unavailable = Object.freeze({
  available: false as const,
  reason: 'owner-capability-missing' as const,
});

test.each([
  { caseName: 'appearing', initiallyOwned: false, mode: 'direct' },
  { caseName: 'changing owner', initiallyOwned: true, mode: 'direct' },
  { caseName: 'appearing', initiallyOwned: false, mode: 'owner-scoped' },
  { caseName: 'changing owner', initiallyOwned: true, mode: 'owner-scoped' },
] as const)(
  'a later foreign manifest $caseName during $mode recovery retains the claim',
  async ({ initiallyOwned, mode }) => {
    const stateDir = mkdtempForTestSync('device-claim-late-resource-');
    const claim = makeClaim(stateDir);
    const env = { AGENT_DEVICE_CLAIMS_DIR: path.join(stateDir, 'claims') };
    writeDeviceClaim(claim, env);
    const sessionDir = path.join(stateDir, 'sessions', claim.session);
    appLogResourceStore.write(
      appLogResourceStore.resolvePath(sessionDir),
      createDurableResourceEnvelope({
        resourceKind: 'app-log',
        sessionId: claim.session,
        device: claim.device,
        owner: localRuntimeOwner('android'),
        fence: { token: 'app-log-fence', generation: 1 },
        lifecycle: 'open',
        descriptor: { version: 1, body: { pid: 123 } },
      }),
    );
    const screenPath = screenRecordingDurableResource.store.resolvePath(sessionDir);
    const writeScreen = (sessionId: string) =>
      screenRecordingDurableResource.store.write(
        screenPath,
        createDurableResourceEnvelope({
          resourceKind: 'screen-recording',
          sessionId,
          device: claim.device,
          owner: localRuntimeOwner('android'),
          fence: { token: 'screen-fence', generation: 1 },
          lifecycle: 'open',
          descriptor: { version: 1, body: {} },
        }),
      );
    if (initiallyOwned) writeScreen(claim.session);
    let enterBind!: () => void;
    const enteredBind = new Promise<void>((resolve) => {
      enterBind = resolve;
    });
    let resumeBind!: () => void;
    const heldBind = new Promise<void>((resolve) => {
      resumeBind = resolve;
    });
    const dispose = vi.fn(async () => {});
    const bind = vi.fn(async ({ device }) => {
      enterBind();
      await heldBind;
      return {
        device,
        owner: localRuntimeOwner('android'),
        facts: {
          device: { family: 'android' as const, kind: device.kind, providerMode: 'local' as const },
          operations: {
            appLogReattach: { available: true as const },
            appLogCleanup: { available: true as const },
          },
        },
        operations: {
          appLogReattach: async () => ({ status: 'missing' as const }),
          appLogCleanup: async () => ({ status: 'cleaned' as const }),
        },
        [Symbol.asyncDispose]: dispose,
      };
    });
    const shutdown = vi.fn(async () => {});
    const gateway = {
      bind,
      shutdown,
    } as unknown as DeviceRuntimeGateway<PlatformRuntimeOperations>;
    const reconciler =
      mode === 'owner-scoped'
        ? createOwnerScopedDeviceClaimReconciler({
            scope,
            beforeGateway: inspectDeviceClaimRecovery,
            composeGateway: () => gateway,
          })
        : createDeviceClaimReconciler({ gateway, scope });
    const settlement = settleVerifiedOrphanedClaim(claim, reconciler, env);
    await enteredBind;
    writeScreen('foreign-session');
    resumeBind();

    await expect(settlement).resolves.toEqual({
      status: 'retained',
      reason: 'screen-recording-owner-mismatch',
    });
    expect(fs.existsSync(resolveDeviceClaimPath(claim.deviceKey, env))).toBe(true);
    expect(bind).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledTimes(mode === 'owner-scoped' ? 1 : 0);
    expect(screenRecordingDurableResource.store.read(screenPath)).toMatchObject({
      status: 'decoded',
      envelope: { sessionId: 'foreign-session', lifecycle: 'open' },
    });
  },
);

function makeClaim(stateDir: string): DeviceClaim {
  return {
    schemaVersion: 3,
    claimOwnerKind: 'open-session',
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
