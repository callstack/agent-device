import { expect, test, vi } from 'vitest';
import { applicationLifecycleOperationFacts } from '@agent-device/contracts/application-lifecycle-runtime';
import {
  type DeviceBinding,
  type DeviceRuntimeGateway,
  type RuntimeFacts,
  type RuntimeOperationFact,
  localRuntimeOwner,
  providerRuntimeOwner,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { unavailableDeploymentSnapshotAndShutdownOperationFacts } from '../../__tests__/test-utils/runtime-operation-facts.ts';
import type { SessionState } from '../types.ts';
import { finalizeDaemonSessionApplicationLifecycle } from '../application-lifecycle-recovery.ts';

const localMechanics = vi.hoisted(() => ({
  adbEvaluated: false,
  imeRestore: vi.fn(async () => ({ reason: 'not-enabled' as const })),
  runnerEvaluated: false,
  runnerStop: vi.fn(async () => {}),
  simctlEvaluated: false,
}));

vi.mock('@agent-device/platform-android/mechanics', () => {
  localMechanics.adbEvaluated = true;
  return { restoreAndroidTestIme: localMechanics.imeRestore };
});
vi.mock('@agent-device/platform-apple', async (importOriginal) => {
  localMechanics.simctlEvaluated = true;
  localMechanics.runnerEvaluated = true;
  const actual = await importOriginal<typeof import('@agent-device/platform-apple')>();
  return { ...actual, stopIosRunnerSession: localMechanics.runnerStop };
});

const device = {
  platform: 'android' as const,
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator' as const,
  target: 'mobile' as const,
  booted: true,
};

const session: SessionState = {
  name: 'lifecycle-recovery',
  device,
  createdAt: 1,
  actions: [],
};

const unavailable = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
} as const);
const available = Object.freeze({ available: true } as const);

function lifecycleFacts(
  finalization: RuntimeOperationFact = available,
  runtimeHintClear: RuntimeOperationFact = unavailable,
): RuntimeFacts<PlatformRuntimeOperations> {
  return {
    device: {
      family: 'android',
      kind: 'emulator',
      target: 'mobile',
      providerMode: 'local',
    },
    operations: {
      appLogInspect: unavailable,
      appLogDoctor: unavailable,
      appLogStart: unavailable,
      appLogReattach: unavailable,
      appLogCleanup: unavailable,
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
        clearRuntimeHints: runtimeHintClear,
        closeApplication: unavailable,
        finalizeApplicationClose: finalization,
        prepareAppleRunner: unavailable,
        configureProviderPortReverse: unavailable,
      }),
    },
  };
}

function gateway(
  params: {
    facts?: RuntimeFacts<PlatformRuntimeOperations>;
    finalize?: () => Promise<void>;
    clearRuntimeHints?: () => Promise<void>;
    dispose?: () => Promise<void>;
  } = {},
): {
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  inspectFacts: ReturnType<typeof vi.fn>;
  bind: ReturnType<typeof vi.fn>;
} {
  const facts = params.facts ?? lifecycleFacts();
  const binding: DeviceBinding<PlatformRuntimeOperations> = {
    device,
    owner: localRuntimeOwner('android'),
    facts,
    operations: {
      finalizeApplicationClose: params.finalize ?? (async () => {}),
      ...(params.clearRuntimeHints === undefined
        ? {}
        : { clearRuntimeHints: params.clearRuntimeHints }),
    },
    [Symbol.asyncDispose]: params.dispose ?? (async () => {}),
  };
  const inspectFacts = vi.fn(async () => facts);
  const bind = vi.fn(async () => binding);
  return {
    gateway: { inspectFacts, bind, shutdown: async () => {} },
    inspectFacts,
    bind,
  };
}

function scope(events: Array<Record<string, unknown>> = []): PlatformRequestScope {
  return {
    signal: new AbortController().signal,
    diagnostics: { emit: (event) => events.push(event as Record<string, unknown>) },
    progress: { report: () => {} },
  };
}

function providerLifecycleFacts(device: DeviceInfo): RuntimeFacts<PlatformRuntimeOperations> {
  const facts = lifecycleFacts();
  return {
    ...facts,
    device: {
      family: device.platform,
      kind: device.kind,
      ...(device.appleOs === undefined ? {} : { appleOs: device.appleOs }),
      ...(device.target === undefined ? {} : { target: device.target }),
      providerMode: 'provider-runtime',
    },
  };
}

function resetLocalMechanics(): void {
  localMechanics.adbEvaluated = false;
  localMechanics.imeRestore.mockClear();
  localMechanics.runnerEvaluated = false;
  localMechanics.runnerStop.mockClear();
  localMechanics.simctlEvaluated = false;
}

test('daemon lifecycle finalization admits facts once, binds once, and disposes after success', async () => {
  const finalize = vi.fn(async () => {});
  const dispose = vi.fn(async () => {});
  const runtime = gateway({ finalize, dispose });

  await finalizeDaemonSessionApplicationLifecycle({
    gateway: runtime.gateway,
    scope: scope(),
    session,
    stateDir: '/state',
    runtimeHints: { metroHost: '10.0.2.2', metroPort: '8081' },
  });

  expect(runtime.inspectFacts).toHaveBeenCalledTimes(1);
  expect(runtime.bind).toHaveBeenCalledTimes(1);
  expect(finalize).toHaveBeenCalledWith({
    appBundleId: undefined,
    surface: 'app',
    retainRunner: false,
    stateDir: '/state',
    daemonShutdown: true,
  });
  expect(dispose).toHaveBeenCalledOnce();
});

test.each([
  {
    name: 'Android provider device',
    device: {
      platform: 'android' as const,
      id: 'provider:android:lease-a',
      name: 'Provider Android',
      kind: 'device' as const,
      target: 'mobile' as const,
      booted: true,
    },
    owner: providerRuntimeOwner('fixture', 'android'),
  },
  {
    name: 'iOS provider device',
    device: {
      platform: 'apple' as const,
      appleOs: 'ios' as const,
      id: 'provider:ios:lease-a',
      name: 'Provider iPhone',
      kind: 'device' as const,
      target: 'mobile' as const,
      booted: true,
    },
    owner: providerRuntimeOwner('fixture', 'ios'),
  },
] satisfies ReadonlyArray<
  Readonly<{ name: string; device: DeviceInfo; owner: ReturnType<typeof providerRuntimeOwner> }>
>)(
  'provider-owned daemon lifecycle recovery for $name performs no local ADB, simctl, or runner cleanup',
  async ({ device: providerDevice, owner }) => {
    resetLocalMechanics();
    const facts = providerLifecycleFacts(providerDevice);
    const dispose = vi.fn(async () => {});
    const binding: DeviceBinding<PlatformRuntimeOperations> = {
      device: providerDevice,
      owner,
      facts,
      operations: { finalizeApplicationClose: async () => undefined },
      [Symbol.asyncDispose]: dispose,
    };
    const inspectFacts = vi.fn(async () => facts);
    const bind = vi.fn(async () => binding);
    const providerGateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
      inspectFacts,
      bind,
      shutdown: async () => {},
    };
    const providerSession: SessionState = {
      name: `provider-${providerDevice.platform}-lifecycle-recovery`,
      device: providerDevice,
      createdAt: 1,
      actions: [],
    };

    await finalizeDaemonSessionApplicationLifecycle({
      gateway: providerGateway,
      scope: scope(),
      session: providerSession,
      stateDir: '/state',
      runtimeHints: {},
    });

    expect(inspectFacts).toHaveBeenCalledExactlyOnceWith(providerDevice);
    expect(bind).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ device: providerDevice, intent: { kind: 'ordinary' } }),
    );
    expect(dispose).toHaveBeenCalledOnce();
    expect(localMechanics.adbEvaluated).toBe(false);
    expect(localMechanics.imeRestore).not.toHaveBeenCalled();
    expect(localMechanics.simctlEvaluated).toBe(false);
    expect(localMechanics.runnerEvaluated).toBe(false);
    expect(localMechanics.runnerStop).not.toHaveBeenCalled();
  },
);

test('daemon lifecycle finalization rejects a false fact before binding', async () => {
  const runtime = gateway({ facts: lifecycleFacts(unavailable) });

  await expect(
    finalizeDaemonSessionApplicationLifecycle({
      gateway: runtime.gateway,
      scope: scope(),
      session,
      stateDir: '/state',
      runtimeHints: {},
    }),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'owner-capability-missing', deviceId: device.id },
  });

  expect(runtime.inspectFacts).toHaveBeenCalledTimes(1);
  expect(runtime.bind).not.toHaveBeenCalled();
});

test('daemon lifecycle finalization admits its distinct runtime-hint cleanup before one bind', async () => {
  const finalize = vi.fn(async () => {});
  const clearRuntimeHints = vi.fn(async () => {});
  const dispose = vi.fn(async () => {});
  const runtime = gateway({
    facts: lifecycleFacts(available, available),
    finalize,
    clearRuntimeHints,
    dispose,
  });
  const sessionWithApplication: SessionState = {
    ...session,
    appBundleId: 'com.example.app',
  };
  const runtimeHints = { metroHost: '10.0.2.2', metroPort: '8081' };

  await finalizeDaemonSessionApplicationLifecycle({
    gateway: runtime.gateway,
    scope: scope(),
    session: sessionWithApplication,
    stateDir: '/state',
    runtimeHints,
  });

  expect(runtime.inspectFacts).toHaveBeenCalledTimes(1);
  expect(runtime.bind).toHaveBeenCalledTimes(1);
  expect(finalize).toHaveBeenCalledOnce();
  expect(clearRuntimeHints).toHaveBeenCalledExactlyOnceWith({
    appId: 'com.example.app',
    values: runtimeHints,
  });
  expect(finalize.mock.invocationCallOrder[0]).toBeLessThan(
    clearRuntimeHints.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
  );
  expect(dispose).toHaveBeenCalledOnce();
});

test('daemon lifecycle finalization rejects a false runtime-hint cleanup fact before binding', async () => {
  const runtime = gateway({ facts: lifecycleFacts(available, unavailable) });
  const sessionWithApplication: SessionState = {
    ...session,
    appBundleId: 'com.example.app',
  };

  await expect(
    finalizeDaemonSessionApplicationLifecycle({
      gateway: runtime.gateway,
      scope: scope(),
      session: sessionWithApplication,
      stateDir: '/state',
      runtimeHints: { metroHost: '10.0.2.2' },
    }),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'owner-capability-missing', deviceId: device.id },
  });

  expect(runtime.inspectFacts).toHaveBeenCalledTimes(1);
  expect(runtime.bind).not.toHaveBeenCalled();
});

test('daemon lifecycle finalization keeps an operation failure primary over binding disposal failure', async () => {
  const operationFailure = new Error('finalization failed');
  const disposalFailure = new Error('binding disposal failed');
  const events: Array<Record<string, unknown>> = [];
  const runtime = gateway({
    finalize: async () => {
      throw operationFailure;
    },
    dispose: async () => {
      throw disposalFailure;
    },
  });

  await expect(
    finalizeDaemonSessionApplicationLifecycle({
      gateway: runtime.gateway,
      scope: scope(events),
      session,
      stateDir: '/state',
      runtimeHints: {},
    }),
  ).rejects.toBe(operationFailure);

  expect(runtime.inspectFacts).toHaveBeenCalledTimes(1);
  expect(runtime.bind).toHaveBeenCalledTimes(1);
  expect(events).toEqual([
    expect.objectContaining({
      level: 'error',
      phase: 'daemon_lifecycle_binding_cleanup_failed',
      data: expect.objectContaining({
        session: session.name,
        error: 'binding disposal failed',
        operationError: 'finalization failed',
      }),
    }),
  ]);
});
