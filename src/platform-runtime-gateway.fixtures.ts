import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { Interactor } from '@agent-device/contracts/interaction';
import type {
  ApplicationLifecycleRuntimeOperations,
  DeviceBinding,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
  PlatformRequestScope,
  RuntimeFacts,
  RuntimeOwnerRef,
} from '@agent-device/contracts/platform';
import {
  applicationLifecycleOperationFacts,
  availableApplicationLifecycleOperations,
} from '@agent-device/contracts/application-lifecycle-runtime';
import { providerRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { LimrunRuntimeDependencies } from '@agent-device/provider-limrun';
import { unavailableDeploymentSnapshotAndShutdownOperationFacts } from './__tests__/test-utils/runtime-operation-facts.ts';
import {
  createComposedPlatformRuntimeGateway,
  type PlatformRuntimeProviderRegistration,
} from './platform-runtime-gateway.ts';

export const gatewayFixtureDevice: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'limrun:ios:lease-a',
  name: 'Provider iOS',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

export const gatewayFixtureScope: PlatformRequestScope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => {} },
  progress: { report: () => {} },
};

export const LIFECYCLE_FACETS = [
  ['openTarget', ['resolveOpenTarget', 'prepareApplicationOpen', 'openApplication']],
  ['prepareAppleRunner', ['prepareAppleRunner']],
  ['closeTarget', ['closeApplication', 'finalizeApplicationClose']],
  ['runtimeHints', ['applyRuntimeHints', 'clearRuntimeHints']],
] as const;

export type LifecycleFacet = (typeof LIFECYCLE_FACETS)[number][0];

export function gatewayFixture(registrations: readonly PlatformRuntimeProviderRegistration[]) {
  return createComposedPlatformRuntimeGateway({
    modules: new Map(),
    loadHost: async () => ({}) as PlatformRuntimeHost,
    providerRuntimes: registrations.map(({ runtime }) => runtime),
    providerModules: registrations,
  });
}

export function providerRuntimeFixture(options: {
  ref: RuntimeOwnerRef;
  provider?: string;
  ownsDevice?: (device: DeviceInfo) => boolean;
  mismatch?: 'owner' | 'device' | 'facts';
  disposed?: () => Promise<void>;
  load?: () => Promise<PlatformRuntimeOwner>;
}): PlatformRuntimeProviderRegistration {
  const owner = runtimeOwnerFixture(options);
  const runtime: ProviderDeviceRuntime = {
    provider: options.provider ?? 'limrun',
    leaseLifecycle: {},
    deviceInventoryProvider: async () => null,
    ownsDevice: options.ownsDevice ?? (() => true),
    getInteractor: () => undefined,
    shutdown: async () => {},
  };
  return {
    runtime,
    module: {
      owner: options.ref as Extract<RuntimeOwnerRef, { kind: 'provider-runtime' }>,
      loadRuntime: options.load ?? (async () => owner),
    },
  };
}

export function runtimeOwnerFixture(options: {
  ref: RuntimeOwnerRef;
  mismatch?: 'owner' | 'device' | 'facts';
  providerMode?: 'local' | 'transport-composed' | 'provider-runtime';
  disposed?: () => Promise<void>;
}): PlatformRuntimeOwner {
  return {
    owner: options.ref,
    ownsDevice: () => true,
    inspectFacts: async () => binding(options).facts,
    bind: async () => binding(options),
    shutdown: async () => {},
  };
}

function binding(options: {
  ref: RuntimeOwnerRef;
  mismatch?: 'owner' | 'device' | 'facts';
  providerMode?: 'local' | 'transport-composed' | 'provider-runtime';
  disposed?: () => Promise<void>;
}): DeviceBinding<PlatformRuntimeOperations> {
  const bindingDevice =
    options.mismatch === 'device' ? { ...gatewayFixtureDevice, id: 'wrong' } : gatewayFixtureDevice;
  const bindingOwner =
    options.mismatch === 'owner' ? providerRuntimeOwner('limrun', 'wrong') : options.ref;
  return {
    device: bindingDevice,
    owner: bindingOwner,
    facts: {
      device: {
        family: bindingDevice.platform,
        appleOs: bindingDevice.appleOs,
        kind: bindingDevice.kind,
        target: bindingDevice.target,
        providerMode:
          options.mismatch === 'facts'
            ? 'transport-composed'
            : (options.providerMode ?? 'provider-runtime'),
      },
      operations: unavailableFacts(),
    },
    operations: {},
    [Symbol.asyncDispose]: options.disposed ?? (async () => {}),
  };
}

function unavailableFacts() {
  const unavailable = { available: false, reason: 'unsupported-provider-mode' } as const;
  return {
    ...unavailableDeploymentSnapshotAndShutdownOperationFacts,
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
  };
}

export function providerLifecycleOwnerFixture(
  ref: Extract<RuntimeOwnerRef, { kind: 'provider-runtime' }>,
  unavailableFacet: LifecycleFacet,
): PlatformRuntimeOwner {
  const unavailable = Object.freeze({
    available: false,
    reason: 'unsupported-provider-mode',
  } as const);
  const available = Object.freeze({ available: true } as const);
  const lifecycleFacts = applicationLifecycleOperationFacts({
    resolveOpenTarget: unavailableFacet === 'openTarget' ? unavailable : available,
    prepareApplicationOpen: unavailableFacet === 'openTarget' ? unavailable : available,
    openApplication: unavailableFacet === 'openTarget' ? unavailable : available,
    applyRuntimeHints: unavailableFacet === 'runtimeHints' ? unavailable : available,
    clearRuntimeHints: unavailableFacet === 'runtimeHints' ? unavailable : available,
    closeApplication: unavailableFacet === 'closeTarget' ? unavailable : available,
    finalizeApplicationClose: unavailableFacet === 'closeTarget' ? unavailable : available,
    prepareAppleRunner: unavailableFacet === 'prepareAppleRunner' ? unavailable : available,
    configureProviderPortReverse: unavailable,
  });
  const facts: RuntimeFacts<PlatformRuntimeOperations> = {
    device: {
      family: gatewayFixtureDevice.platform,
      appleOs: gatewayFixtureDevice.appleOs,
      kind: gatewayFixtureDevice.kind,
      target: gatewayFixtureDevice.target,
      providerMode: 'provider-runtime',
    },
    operations: { ...unavailableFacts(), ...lifecycleFacts },
  };
  const operations = availableApplicationLifecycleOperations(
    lifecycleOperations(),
    facts.operations,
  );
  return {
    owner: ref,
    ownsDevice: () => true,
    inspectFacts: async () => facts,
    bind: async () => ({
      device: gatewayFixtureDevice,
      owner: ref,
      facts,
      operations: operations as PlatformRuntimeOperations,
      [Symbol.asyncDispose]: async () => {},
    }),
    shutdown: async () => {},
  };
}

function lifecycleOperations(): ApplicationLifecycleRuntimeOperations {
  return {
    resolveOpenTarget: async () => ({}),
    prepareApplicationOpen: async () => {},
    openApplication: async () => ({ timing: {} }),
    applyRuntimeHints: async () => {},
    clearRuntimeHints: async () => {},
    closeApplication: async () => {},
    finalizeApplicationClose: async () => {},
    prepareAppleRunner: async () => ({ runner: {}, connectMs: 0, healthCheckMs: 0 }),
    configureProviderPortReverse: async () => undefined,
  };
}

export const limrunTestDependencies = {
  clientVersion: 'test',
  android: {
    createInteractor: () => ({}) as Interactor,
    createPortReverse: async () => ({
      ensure: async () => {},
      remove: async () => {},
      removeAllOwned: async () => {},
    }),
    inferAppName: async () => 'unused',
    listApps: async () => [],
    getForegroundApp: async () => undefined,
    getKeyboardState: async () => ({ visible: false, inputOwner: 'unknown' as const }),
    dismissKeyboard: async () => ({
      visible: false,
      inputOwner: 'unknown' as const,
      attempts: 0,
      wasVisible: false,
      dismissed: false,
    }),
    readLogs: async () => '',
    adbError: async () => {
      throw new Error('unused');
    },
  },
  host: {
    runAdb: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    archiveDirectory: async () => {},
  },
  ios: {
    resolveAppAlias: async (app: string) => app,
    readBundleAppName: async () => undefined,
  },
} satisfies LimrunRuntimeDependencies;
