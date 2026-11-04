import { createDeviceClaimReconciler } from './device-claim-reconciliation.ts';
import { inspectDeviceClaimRecovery } from '@agent-device/daemon-contracts/device-claim-recovery';
import { appLogResourceStore } from '@agent-device/capture-kit/app-log-durable-resource';
import { audioProbeDurableResource } from '@agent-device/capture-kit/audio-probe-session-resource';
import { perfCaptureDurableResource } from '@agent-device/capture-kit/perf-capture-session-resource';
import { screenRecordingDurableResource } from '@agent-device/capture-kit/screen-recording-session-resource';
import { createScreenRecordingRecoveryControl } from '@agent-device/capture-kit/screen-recording-recovery';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import {
  createDurableResourceEnvelope,
  createScreenRecordingLiveHandle,
} from '@agent-device/capture-kit';
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
      ...(kind === 'screen-recording' ? { metadata: { deviceClaimToken: claim.ownerToken } } : {}),
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
    const baseClaim = makeClaim(stateDir);
    const claim: DeviceClaim = initiallyOwned
      ? {
          ...baseClaim,
          claimOwnerKind: 'transient-command',
          transientCommand: 'record',
          recordingFence: { token: 'screen-fence', generation: 1 },
        }
      : {
          ...baseClaim,
          recordingFence: undefined,
          recordingRuntimeOwner: undefined,
        };
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
          metadata: { deviceClaimToken: claim.ownerToken },
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
    expect(inspectDeviceClaimRecovery(claim).status).toBe('inspectable');
    const settlement = settleVerifiedOrphanedClaim(claim, reconciler, env);
    try {
      const phase = await Promise.race([
        enteredBind.then(() => ({ phase: 'binding' as const })),
        settlement.then((result) => ({ phase: 'settled' as const, result })),
      ]);
      expect(phase).toEqual({ phase: 'binding' });
      writeScreen('foreign-session');
    } finally {
      resumeBind();
    }

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
    recordingFence: { token: 'fence', generation: 1 },
    recordingRuntimeOwner: localRuntimeOwner('android'),
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

test('an open-session recording with no surviving-owner authority is retained before recovery', async () => {
  const stateDir = mkdtempForTestSync('unproven-session-owner-');
  const claim = makeClaim(stateDir);
  const env = { AGENT_DEVICE_CLAIMS_DIR: path.join(stateDir, 'claims') };
  writeDeviceClaim(claim, env);
  const claimPath = resolveDeviceClaimPath(claim.deviceKey, env);
  const before = fs.readFileSync(claimPath);
  const reconcile = vi.fn(async () => ({ status: 'reconciled' as const }));

  await expect(settleVerifiedOrphanedClaim(claim, reconcile, env)).resolves.toEqual({
    status: 'retained',
    reason: 'screen-recording-session-owner-unproven',
  });
  expect(reconcile).not.toHaveBeenCalled();
  expect(fs.readFileSync(claimPath)).toEqual(before);
});

test.each(['open-session', 'transient-command'] as const)(
  'a %s recording with an outstanding session owner never enters recovery',
  async (kind) => {
    const stateDir = mkdtempForTestSync('pending-session-owner-');
    const claim: DeviceClaim = {
      ...makeClaim(stateDir),
      claimOwnerKind: kind,
      ...(kind === 'transient-command' ? { transientCommand: 'record' } : {}),
      recordingSessionOwner: { pid: 123, startTime: 'owner-start' },
    };
    const env = { AGENT_DEVICE_CLAIMS_DIR: path.join(stateDir, 'claims') };
    writeDeviceClaim(claim, env);
    const claimPath = resolveDeviceClaimPath(claim.deviceKey, env);
    const before = fs.readFileSync(claimPath);
    const reconcile = vi.fn(async () => ({ status: 'reconciled' as const }));
    await expect(settleVerifiedOrphanedClaim(claim, reconcile, env)).resolves.toEqual({
      status: 'retained',
      reason: 'screen-recording-session-owner-pending',
    });
    expect(reconcile).not.toHaveBeenCalled();
    expect(fs.readFileSync(claimPath)).toEqual(before);
  },
);

test.each([
  { evidence: 'missing token', token: undefined, generation: 1, reason: 'provenance-unconfirmed' },
  { evidence: 'replacement token', token: 'other-token', generation: 1, reason: 'owner-mismatch' },
  {
    evidence: 'replacement generation',
    token: 'claim-token',
    generation: 2,
    reason: 'owner-mismatch',
  },
] as const)(
  'recording $evidence is retained before binding or settlement',
  async ({ token, generation, reason }) => {
    const stateDir = mkdtempForTestSync('unproven-recording-');
    const claim: DeviceClaim = {
      ...makeClaim(stateDir),
      claimOwnerKind: 'transient-command',
      transientCommand: 'record',
    };
    const env = { AGENT_DEVICE_CLAIMS_DIR: path.join(stateDir, 'claims') };
    writeDeviceClaim(claim, env);
    const resourcePath = screenRecordingDurableResource.store.resolvePath(
      path.join(stateDir, 'sessions', claim.session),
    );
    screenRecordingDurableResource.store.write(
      resourcePath,
      createDurableResourceEnvelope({
        resourceKind: 'screen-recording',
        sessionId: claim.session,
        device: claim.device,
        owner: localRuntimeOwner('android'),
        fence: { token: 'fence', generation },
        lifecycle: 'open',
        descriptor: { version: 1, body: {} },
        ...(token === undefined ? {} : { metadata: { deviceClaimToken: token } }),
      }),
    );
    const before = fs.readFileSync(resourcePath);
    const bind = vi.fn();
    const gateway = { bind } as unknown as DeviceRuntimeGateway<PlatformRuntimeOperations>;
    await expect(
      settleVerifiedOrphanedClaim(claim, createDeviceClaimReconciler({ gateway, scope }), env),
    ).resolves.toEqual({ status: 'retained', reason: `screen-recording-${reason}` });
    expect(bind).not.toHaveBeenCalled();
    expect(fs.readFileSync(resourcePath)).toEqual(before);
    expect(
      JSON.parse(fs.readFileSync(resolveDeviceClaimPath(claim.deviceKey, env), 'utf8')),
    ).toMatchObject({ ownerToken: claim.ownerToken });
  },
);

test('missing finalized simulator export retains the claim and recovered stop reports missing', async () => {
  const stateDir = mkdtempForTestSync('missing-recording-claim-');
  const claim = {
    ...makeClaim(stateDir),
    claimOwnerKind: 'transient-command' as const,
    transientCommand: 'record',
    recordingFence: { token: 'screen-fence', generation: 1 },
    recordingRuntimeOwner: localRuntimeOwner('apple'),
    deviceKey: 'local:apple:ios:sim',
    device: {
      family: 'apple' as const,
      appleOs: 'ios' as const,
      id: 'sim',
      name: 'sim',
      kind: 'simulator' as const,
    },
  };
  const env = { AGENT_DEVICE_CLAIMS_DIR: path.join(stateDir, 'claims') };
  writeDeviceClaim(claim, env);
  const native = path.join(stateDir, 'native.mp4');
  const output = path.join(stateDir, 'missing.mp4');
  fs.writeFileSync(native, 'native bytes');
  const resourcePath = screenRecordingDurableResource.store.resolvePath(
    path.join(stateDir, 'sessions', claim.session),
  );
  screenRecordingDurableResource.store.write(
    resourcePath,
    createDurableResourceEnvelope({
      resourceKind: 'screen-recording',
      sessionId: claim.session,
      device: claim.device,
      owner: localRuntimeOwner('apple'),
      fence: { token: 'screen-fence', generation: 1 },
      lifecycle: 'open',
      descriptor: { version: 1, body: { backend: 'simctl', outputPath: native } },
      metadata: {
        deviceClaimToken: claim.ownerToken,
        stopObservation: { recorder: 'confirmed' },
        stoppedAtMs: 1,
        exportPath: output,
        stopFinalization: { telemetryPath: '/tmp/telemetry' },
      },
    }),
  );
  const cleanup = vi.fn(async () => ({ status: 'cleaned' as const }));
  const operations = {
    screenRecordingReattach: async () => ({ status: 'missing' as const }),
    screenRecordingCleanup: cleanup,
  };
  const bind = async ({ device }: { device: unknown }) => ({
    device,
    owner: localRuntimeOwner('apple'),
    facts: {
      device: { family: 'apple', kind: 'simulator', providerMode: 'local' },
      operations: {
        screenRecordingReattach: { available: true },
        screenRecordingCleanup: { available: true },
      },
    },
    operations,
    [Symbol.asyncDispose]: async () => {},
  });
  const gateway = {
    bind,
    shutdown: async () => {},
  } as unknown as DeviceRuntimeGateway<PlatformRuntimeOperations>;
  const result = await settleVerifiedOrphanedClaim(
    claim,
    createDeviceClaimReconciler({ gateway, scope }),
    env,
  );
  expect(result).toEqual({ status: 'retained', reason: 'screen-recording-resource-missing' });
  const claimPath = resolveDeviceClaimPath(claim.deviceKey, env);
  expect(JSON.parse(fs.readFileSync(claimPath, 'utf8')).ownerToken).toBe(claim.ownerToken);
  expect(screenRecordingDurableResource.store.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open' },
  });
  await expect(
    screenRecordingDurableResource.finishRecovered({
      resourcePath,
      scope,
      acquireControl: async () =>
        createScreenRecordingRecoveryControl({
          runtime: { operations } as never,
          dispose: async () => {},
        }),
    }),
  ).rejects.toMatchObject({ code: 'COMMAND_FAILED', details: { reason: 'resource-missing' } });
  expect(cleanup).not.toHaveBeenCalled();
  expect(fs.readFileSync(native, 'utf8')).toBe('native bytes');
  expect(fs.existsSync(output)).toBe(false);
  expect(JSON.parse(fs.readFileSync(claimPath, 'utf8')).ownerToken).toBe(claim.ownerToken);
});

test('claim reconciliation retains the exact recording claim and journals settlement without cleaning material', async () => {
  const stateDir = mkdtempForTestSync('preservation-claim-');
  const claim: DeviceClaim = {
    ...makeClaim(stateDir),
    claimOwnerKind: 'transient-command',
    transientCommand: 'record',
  };
  const env = { AGENT_DEVICE_CLAIMS_DIR: path.join(stateDir, 'claims') };
  writeDeviceClaim(claim, env);
  const resourcePath = screenRecordingDurableResource.store.resolvePath(
    path.join(stateDir, 'sessions', claim.session),
  );
  const native = path.join(stateDir, 'chunk.mp4');
  const marker = path.join(stateDir, 'device-marker.json');
  fs.writeFileSync(native, 'native bytes');
  fs.writeFileSync(marker, 'device marker');
  screenRecordingDurableResource.store.write(
    resourcePath,
    createDurableResourceEnvelope({
      resourceKind: 'screen-recording',
      sessionId: claim.session,
      device: claim.device,
      owner: localRuntimeOwner('android'),
      fence: { token: 'fence', generation: 1 },
      lifecycle: 'open',
      descriptor: { version: 1, body: {} },
      metadata: { deviceClaimToken: claim.ownerToken },
    }),
  );
  const cleanup = vi.fn(async () => ({ status: 'cleaned' as const }));
  const signal = vi.fn();
  const handle = createScreenRecordingLiveHandle(
    {
      backend: 'fixture',
      outPath: '/tmp/output',
      startedAt: 1,
      scope: 'device',
      showTouches: false,
      recordOnlySession: false,
      gestureEvents: [],
    },
    {
      finish: async () => {
        throw new Error('unexpected finish');
      },
      forceCleanup: cleanup,
    },
  );
  const disposeControl = vi.fn(async () => {});
  const operations = {
    screenRecordingReattach: async () => ({
      status: 'active' as const,
      handle: {
        ...handle,
        settleForExport: async (progress: {
          record(fact: { stopObservation: { recorder: 'confirmed' } }): void;
        }) => {
          signal();
          progress.record({ stopObservation: { recorder: 'confirmed' } });
          return { status: 'export' as const };
        },
      },
    }),
    screenRecordingCleanup: cleanup,
  };
  const gateway = {
    bind: async ({ device }: { device: unknown }) => ({
      device,
      owner: localRuntimeOwner('android'),
      facts: {
        device: { family: 'android', kind: 'emulator', providerMode: 'local' },
        operations: {
          screenRecordingReattach: { available: true },
          screenRecordingCleanup: { available: true },
        },
      },
      operations,
      [Symbol.asyncDispose]: disposeControl,
    }),
  } as unknown as DeviceRuntimeGateway<PlatformRuntimeOperations>;
  await expect(
    settleVerifiedOrphanedClaim(claim, createDeviceClaimReconciler({ gateway, scope }), env),
  ).resolves.toEqual({ status: 'retained', reason: 'screen-recording-export-pending' });
  expect(signal).toHaveBeenCalledOnce();
  expect(cleanup).not.toHaveBeenCalled();
  expect(disposeControl).toHaveBeenCalledOnce();
  expect(fs.readFileSync(native, 'utf8')).toBe('native bytes');
  expect(fs.readFileSync(marker, 'utf8')).toBe('device marker');
  expect(
    JSON.parse(fs.readFileSync(resolveDeviceClaimPath(claim.deviceKey, env), 'utf8')).ownerToken,
  ).toBe(claim.ownerToken);
  expect(screenRecordingDurableResource.store.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open', metadata: { stopObservation: { recorder: 'confirmed' } } },
  });
});

test('a still-live previous daemon cannot be settled while it may publish another chunk', async () => {
  const stateDir = mkdtempForTestSync('recording-live-owner-');
  const claim = { ...makeClaim(stateDir), ownerPid: process.pid, ownerStartTime: null };
  const resourcePath = screenRecordingDurableResource.store.resolvePath(
    path.join(stateDir, 'sessions', claim.session),
  );
  screenRecordingDurableResource.store.write(
    resourcePath,
    createDurableResourceEnvelope({
      resourceKind: 'screen-recording',
      sessionId: claim.session,
      device: claim.device,
      owner: localRuntimeOwner('android'),
      fence: { token: 'fence', generation: 1 },
      lifecycle: 'open',
      descriptor: { version: 1, body: {} },
      metadata: { deviceClaimToken: claim.ownerToken },
    }),
  );
  const bind = vi.fn();
  const gateway = { bind } as unknown as DeviceRuntimeGateway<PlatformRuntimeOperations>;
  await expect(createDeviceClaimReconciler({ gateway, scope })(claim)).resolves.toEqual({
    status: 'retained',
    reason: 'screen-recording-owner-unsettled',
  });
  expect(bind).not.toHaveBeenCalled();
  expect(screenRecordingDurableResource.store.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open' },
  });
});
