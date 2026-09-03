import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import {
  type ApplicationLifecycleRuntimeOperations,
  applicationLifecycleOperationFacts,
  availableApplicationLifecycleOperations,
} from '@agent-device/contracts/application-lifecycle-runtime';
import {
  type DeviceBinding,
  type DeviceBindingRequest,
  type RuntimeFacts,
  type RuntimeOperationKey,
  type RuntimeOwnerRef,
  type RuntimeProviderMode,
  localRuntimeOwner,
  providerRuntimeOwner,
  sameRuntimeOwner,
} from '@agent-device/contracts/platform-runtime';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeModule,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
} from '@agent-device/contracts/platform-runtime-operations';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { DeviceInfo, Platform } from '@agent-device/kernel/device';
import type { LimrunRuntimeDependencies } from '@agent-device/provider-limrun';
import {
  createUnavailableRuntimeFactsForTest,
  unavailableDeploymentSnapshotAndShutdownOperationFacts,
} from './__tests__/test-utils/runtime-operation-facts.ts';
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

/**
 * Every cell a managed local owner must withhold, listed once so the local family fixture can
 * offer all of them and the managed tests can assert that none survives the wrapper.
 */
export const MANAGED_WITHHELD_OPERATIONS = [
  'ensureReady',
  'bootTarget',
  'bootTargetHeadless',
  'shutdownTarget',
  'deployApp',
  'deployMaterializedApp',
  'prepareApplicationOpen',
  'prepareAppleRunner',
  'closeApplication',
  'finalizeApplicationClose',
  'appLogStart',
  'appLogReattach',
  'appLogCleanup',
  'screenRecordingStart',
  'screenRecordingReattach',
  'screenRecordingCleanup',
  'audioProbeStart',
  'audioProbeReattach',
  'audioProbeCleanup',
  'perfNativeCaptureStart',
  'perfNativeCaptureReattach',
  'perfNativeCaptureCleanup',
  'captureScreenshot',
  'setSetting',
  'readClipboard',
  'writeClipboard',
  'openApplication',
] as const satisfies readonly RuntimeOperationKey<PlatformRuntimeOperations>[];

/** The one cell the family owner offers that a managed binding keeps. */
export const MANAGED_RETAINED_OPERATION = 'tapPoint';

export type LocalFamilyRuntimeFixture = Readonly<{
  module: PlatformRuntimeModule;
  /** Every bind request the family owner received, in order. */
  requests: DeviceBindingRequest[];
  calls: { loads: number; disposals: number };
}>;

/**
 * A local family owner that offers every withheld cell plus one retained cell, and that refuses a
 * foreign exact-owner intent the way the real family runtimes do.
 */
export function localFamilyRuntimeFixture(options: {
  family: Platform;
  device: DeviceInfo;
  providerMode?: RuntimeProviderMode;
}): LocalFamilyRuntimeFixture {
  const owner = localRuntimeOwner(options.family);
  const requests: DeviceBindingRequest[] = [];
  const calls = { loads: 0, disposals: 0 };
  const base = createUnavailableRuntimeFactsForTest(options.device, owner);
  const available = Object.freeze({ available: true } as const);
  const offered: Record<string, unknown> = {};
  const operations: Record<string, unknown> = {};
  for (const key of [...MANAGED_WITHHELD_OPERATIONS, MANAGED_RETAINED_OPERATION]) {
    offered[key] = available;
    operations[key] = async () => undefined;
  }
  const facts = Object.freeze({
    device: { ...base.device, providerMode: options.providerMode ?? base.device.providerMode },
    operations: Object.freeze({ ...base.operations, ...offered }),
  }) as RuntimeFacts<PlatformRuntimeOperations>;
  const runtimeOwner: PlatformRuntimeOwner = {
    owner,
    ownsDevice: () => true,
    inspectFacts: async () => facts,
    bind: async (request) => {
      requests.push(request);
      if (request.intent.kind === 'exact-owner' && !sameRuntimeOwner(request.intent.owner, owner)) {
        throw new TypeError('A local family runtime cannot bind a foreign exact owner');
      }
      return {
        device: request.device,
        owner,
        facts,
        operations: operations as DeviceBinding<PlatformRuntimeOperations>['operations'],
        [Symbol.asyncDispose]: async () => {
          calls.disposals += 1;
        },
      };
    },
    shutdown: async () => {},
  };
  return Object.freeze({
    module: {
      family: options.family,
      loadRuntime: async () => {
        calls.loads += 1;
        return runtimeOwner;
      },
    },
    requests,
    calls,
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
    ...createUnavailableRuntimeFactsForTest(
      gatewayFixtureDevice,
      providerRuntimeOwner('limrun', 'fixtures'),
      unavailable,
    ).operations,
    ...unavailableDeploymentSnapshotAndShutdownOperationFacts,
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
