import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import {
  type ApplicationLifecycleRuntimeOperations,
  applicationLifecycleOperationFacts,
  availableApplicationLifecycleOperations,
} from '@agent-device/contracts/application-lifecycle-runtime';
import {
  type DeviceBinding,
  type RuntimeFacts,
  type RuntimeOwnerRef,
  providerRuntimeOwner,
} from '@agent-device/contracts/platform-runtime';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
} from '@agent-device/contracts/platform-runtime-operations';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { LimrunRuntimeDependencies } from '@agent-device/provider-limrun';
import {
  createUnavailableRuntimeFactsForTest,
  unavailableDeploymentSnapshotAndShutdownOperationFacts,
} from '@agent-device/test-kit';
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

export const limrunTestDependencies: LimrunRuntimeDependencies = {
  clientVersion: 'test',
  android: {
    bindDeployment: async () => {
      throw new Error('Unexpected deployment binding');
    },
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
    forceStopApp: async () => {},
    deviceAdbInvocation: (serial: string, command: readonly string[]) => ({
      target: { selector: { kind: 'serial', serial }, server: { kind: 'ambient' } },
      command,
    }),
    hostAdbInvocation: (command: readonly string[]) => ({
      target: { selector: { kind: 'unspecified' }, server: { kind: 'ambient' } },
      command,
    }),
    adbError: async () => {
      throw new Error('unused');
    },
  },
  host: {
    runAdb: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    downloadFile: async () => undefined,
  },
  ios: {
    createAppLogReader: ({ client }) => ({
      readLogs: async (app, limit) => client.appLogTail(app, limit),
      [Symbol.asyncDispose]: async () => {},
    }),
    createRunner: async (session) => createTestLimrunIosRunner(session.device),
    readBundleAppName: async () => undefined,
  },
} satisfies LimrunRuntimeDependencies;

export async function createTestLimrunIosRunner(
  device: DeviceInfo,
  respond?: (command: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<Awaited<ReturnType<LimrunRuntimeDependencies['ios']['createRunner']>>> {
  const { createAppleRunnerRuntime } =
    await import('@agent-device/platform-apple/runner/operations');
  const { createLimrunAppleApplicationTools } =
    await import('./core/interactors/limrun-ios-application-tools.ts');
  const runner = await createAppleRunnerRuntime({
    device,
    host: { env: {}, cwd: process.cwd() },
    provider: {
      hasLiveSession: () => false,
      runCommand: async (_device, command) => {
        if (!respond) throw new Error('Unexpected XCTest runner command');
        return await respond(command);
      },
    },
  });
  const applicationTools = createLimrunAppleApplicationTools(
    device,
    {
      prepareCache: async () => {},
      prewarm: async () => {},
      release: async () => {},
      prepare: (_device, input, signal) => runner.prepare(input, signal),
      resetTarget: async () => {},
      isReady: () => false,
      isStarted: () => false,
      stop: async () => {},
      releaseSpeculative: async () => false,
    },
    {
      resolveOpenTarget: async (_device, input) => ({
        appBundleId: input.target ?? input.currentAppBundleId,
        appName: input.target,
      }),
      applyRuntimeHints: async () => {},
      clearRuntimeHints: async () => {},
    },
  );
  return {
    ...runner,
    applicationTools,
    bindApplicationLifecycle: (request) =>
      runner.bindApplicationLifecycle({
        ...request,
        appleApplications: applicationTools,
        ensureReady: async (target) => target,
      }),
    dispose: async () => {},
  };
}
