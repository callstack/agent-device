import { createProviderDeviceRuntimeRequestProviders } from '../../../src/provider-device-runtime.ts';
import type {
  DeviceInventoryProvider,
  DeviceLease,
  LeaseLifecycleProvider,
  ProviderDeviceRuntime,
  ProviderPortReverseOptions,
} from '@agent-device/contracts/device';
import type {
  Interactor,
  RunnerContext,
  SnapshotResult,
} from '@agent-device/contracts/interactor-types';
import {
  applicationLifecycleOperationFacts,
  availableApplicationLifecycleOperations,
  type ApplicationLifecycleRuntimeOperations,
} from '@agent-device/contracts/application-lifecycle-runtime';
import {
  bindProviderApplicationLifecycleInteractor,
  invokeApplicationClose,
  invokeApplicationOpen,
} from '@agent-device/contracts/application-lifecycle-interaction';
import { bindProviderSnapshotInteractor } from '@agent-device/contracts/snapshot-runtime';
import {
  bindProviderTouchInteractor,
  touchRuntimeOperationFacts,
} from '@agent-device/contracts/touch-runtime';
import {
  providerRuntimeOwner,
  sameRuntimeOwner,
  type DeviceBinding,
  type DeviceBindingRequest,
  type RuntimeFacts,
} from '@agent-device/contracts/platform-runtime';
import type {
  AppDeploymentInput,
  AppDeploymentResult,
} from '@agent-device/contracts/app-deployment-runtime';
import type {
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
  PlatformRuntimeProviderModule,
} from '@agent-device/contracts/platform-runtime-operations';
import { bindAdmittedProviderInteractorOperations } from '@agent-device/contracts/interactor-operation-catalog';
import { unavailableDeploymentSnapshotAndShutdownOperationFacts } from '../../../src/__tests__/test-utils/runtime-operation-facts.ts';
import type { DaemonRequest } from '../../../src/daemon/types.ts';
import { deviceShape, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { createProviderScenarioHarness } from './harness.ts';

export const FAKE_PROVIDER = 'fake-provider';

const ABSENT_FAKE_PROVIDER_INTERACTOR_PROPERTIES = new Set([
  'then',
  'tapElementSelector',
  'fillElementSelector',
  'pressPoint',
  'alternateClick',
  'setViewport',
]);

export type FakeProviderCall = {
  type:
    | 'lease.allocate'
    | 'lease.heartbeat'
    | 'lease.release'
    | 'inventory'
    | 'install'
    | 'open'
    | 'close'
    | 'tap'
    | 'snapshot'
    | 'portReverse.ensure';
  [key: string]: unknown;
};

type FakeProviderSession = {
  device: DeviceInfo;
  interactor: Interactor;
};

export async function createFakeProviderWorld(platform: 'android' | 'ios' = 'android') {
  const runtime = new FakeProviderDeviceRuntime(platform);
  const providerRuntimeProviders = createProviderDeviceRuntimeRequestProviders([runtime]);
  const owner = providerRuntimeOwner(FAKE_PROVIDER, platform);
  const providerModule = createProviderScenarioLifecycleModule(runtime, owner);
  const daemon = await createProviderScenarioHarness({
    ...providerRuntimeProviders,
    deviceInventorySource: providerRuntimeProviders.deviceInventorySource!,
    platformRuntime: {
      providerRuntimes: [runtime],
      providerModules: [{ runtime, module: providerModule }],
    },
  });
  return {
    daemon,
    runtime,
    close: async () => {
      await runtime.shutdown();
      await daemon.close();
    },
  };
}

const fakeProviderAvailable = Object.freeze({ available: true } as const);
const fakeProviderUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
} as const);

/**
 * Test-only explicit provider module. Scenarios opt into it at construction time so their
 * lifecycle open/close traffic crosses the same owner-selected gateway as production; the
 * harness never manufactures this module from ambient request state.
 */
export function createProviderScenarioLifecycleModule(
  runtime: ProviderDeviceRuntime,
  owner: ReturnType<typeof providerRuntimeOwner>,
): PlatformRuntimeProviderModule {
  return Object.freeze({
    owner,
    loadRuntime: async () => createProviderScenarioLifecycleOwner(runtime, owner),
  });
}

function createProviderScenarioLifecycleOwner(
  runtime: ProviderDeviceRuntime,
  owner: ReturnType<typeof providerRuntimeOwner>,
): PlatformRuntimeOwner {
  return Object.freeze({
    owner,
    ownsDevice: (device) => runtime.ownsDevice(device),
    inspectFacts: async (device) => providerScenarioRuntimeFacts(device, runtime),
    bind: async (request) => bindProviderScenarioPlatformRuntime(runtime, owner, request),
    shutdown: async () => undefined,
  });
}

async function bindProviderScenarioPlatformRuntime(
  runtime: ProviderDeviceRuntime,
  owner: ReturnType<typeof providerRuntimeOwner>,
  request: DeviceBindingRequest,
): Promise<DeviceBinding<PlatformRuntimeOperations>> {
  if (!runtime.ownsDevice(request.device)) {
    throw new AppError('UNSUPPORTED_PLATFORM', 'Fake provider runtime does not own this device');
  }
  if (request.intent.kind === 'exact-owner' && !sameRuntimeOwner(request.intent.owner, owner)) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'Fake provider runtime owner identity does not match',
    );
  }
  const facts = providerScenarioRuntimeFacts(request.device, runtime);
  return Object.freeze({
    device: request.device,
    owner,
    facts,
    operations: Object.freeze({
      ...availableApplicationLifecycleOperations(
        providerScenarioApplicationLifecycle(runtime, request.device, request.scope.signal),
        facts.operations,
      ),
      ...bindProviderSnapshotInteractor({
        device: request.device,
        signal: request.scope.signal,
        resolveInteractor: (runner) => runtime.getInteractor(request.device, runner),
      }),
      // The interactor catalog binds every keyboard leg this provider's facts admit.
      ...bindAdmittedProviderInteractorOperations({
        device: request.device,
        signal: request.scope.signal,
        resolveInteractor: (runner) => runtime.getInteractor(request.device, runner),
        facts: facts.operations,
      }),
      ...bindProviderTouchInteractor({
        device: request.device,
        signal: request.scope.signal,
        resolveInteractor: (runner) => runtime.getInteractor(request.device, runner),
        pause: async () => undefined,
        facts: facts.operations,
      }),
      deployApp: async (input: AppDeploymentInput): Promise<AppDeploymentResult> => {
        const result = await runtime.installApp?.(request.device, input.app, input.appPath);
        if (result) return result;
        throw new AppError('UNSUPPORTED_OPERATION', 'Fake provider install is unavailable');
      },
    }),
    [Symbol.asyncDispose]: async () => undefined,
  });
}

function providerScenarioApplicationLifecycle(
  runtime: ProviderDeviceRuntime,
  device: DeviceInfo,
  signal: AbortSignal,
): ApplicationLifecycleRuntimeOperations {
  const binding = bindProviderApplicationLifecycleInteractor({
    device,
    signal,
    resolveInteractor: (runner) => runtime.getInteractor(device, runner),
  });
  return Object.freeze({
    resolveOpenTarget: async (input) => ({
      ...(input.target?.includes('.') ? { appBundleId: input.target } : {}),
      ...(input.target === undefined ? {} : { appName: input.target }),
    }),
    prepareApplicationOpen: async () => undefined,
    openApplication: async (input) => {
      if (input.relaunch && input.target) {
        await invokeApplicationClose({
          device,
          interactor: await binding.resolveInteractor(input.execution, input.appBundleId),
          positionals: [input.appBundleId ?? input.target],
        });
      }
      await invokeApplicationOpen({
        device,
        interactor: await binding.resolveInteractor(input.execution, input.appBundleId),
        positionals: input.positionals,
        appBundleId: input.appBundleId,
        execution: input.execution,
      });
      return { appBundleId: input.appBundleId, timing: {} };
    },
    applyRuntimeHints: async () => undefined,
    clearRuntimeHints: async () => undefined,
    closeApplication: async (input) => {
      await invokeApplicationClose({
        device,
        interactor: await binding.resolveInteractor(input.execution, input.appBundleId),
        positionals: input.positionals,
      });
    },
    finalizeApplicationClose: async () => ({}),
    prepareAppleRunner: async () => {
      throw new AppError('UNSUPPORTED_OPERATION', 'Fake provider does not prepare Apple runners.');
    },
    configureProviderPortReverse: runtime.configurePortReverse
      ? async (input) => await runtime.configurePortReverse?.(input)
      : unavailableProviderScenarioOperation,
  });
}

function providerScenarioRuntimeFacts(
  device: DeviceInfo,
  runtime: ProviderDeviceRuntime,
): RuntimeFacts<PlatformRuntimeOperations> {
  return Object.freeze({
    device: { ...deviceShape(device), providerMode: 'provider-runtime' },
    operations: {
      appLogInspect: fakeProviderUnavailable,
      appLogDoctor: fakeProviderUnavailable,
      appLogStart: fakeProviderUnavailable,
      appLogReattach: fakeProviderUnavailable,
      appLogCleanup: fakeProviderUnavailable,
      appState: fakeProviderUnavailable,
      networkDump: fakeProviderUnavailable,
      screenRecordingStart: fakeProviderUnavailable,
      screenRecordingReattach: fakeProviderUnavailable,
      screenRecordingCleanup: fakeProviderUnavailable,
      ensureReady: fakeProviderUnavailable,
      bootTarget: fakeProviderUnavailable,
      bootTargetHeadless: fakeProviderUnavailable,
      listApps: fakeProviderUnavailable,
      ...unavailableDeploymentSnapshotAndShutdownOperationFacts,
      captureSnapshot: fakeProviderAvailable,
      // Provider-owned iOS keyboard actions ride the same runner transport the shared interactor
      // does (#1297): a fixture scenario that can drive the interactor at all can drive these.
      keyboardDismiss: fakeProviderAvailable,
      keyboardEnter: fakeProviderAvailable,
      ...touchRuntimeOperationFacts({
        tap: fakeProviderAvailable,
        longPress: fakeProviderAvailable,
        hover: fakeProviderUnavailable,
        fill: fakeProviderAvailable,
        tapElementSelector: fakeProviderUnavailable,
      }),
      deployApp: runtime.installApp ? fakeProviderAvailable : fakeProviderUnavailable,
      ...applicationLifecycleOperationFacts({
        resolveOpenTarget: fakeProviderAvailable,
        prepareApplicationOpen: fakeProviderAvailable,
        openApplication: fakeProviderAvailable,
        applyRuntimeHints: fakeProviderUnavailable,
        clearRuntimeHints: fakeProviderUnavailable,
        closeApplication: fakeProviderAvailable,
        finalizeApplicationClose: fakeProviderAvailable,
        prepareAppleRunner: fakeProviderUnavailable,
        configureProviderPortReverse:
          device.platform === 'android' && runtime.configurePortReverse
            ? fakeProviderAvailable
            : fakeProviderUnavailable,
      }),
    },
  });
}

async function unavailableProviderScenarioOperation(): Promise<never> {
  throw new AppError('UNSUPPORTED_OPERATION', 'This provider scenario operation is unavailable.');
}

export class FakeProviderDeviceRuntime implements ProviderDeviceRuntime {
  readonly provider = FAKE_PROVIDER;
  readonly calls: FakeProviderCall[] = [];
  private readonly sessionsByLeaseId = new Map<string, FakeProviderSession>();
  private readonly platform: 'android' | 'ios';

  constructor(platform: 'android' | 'ios' = 'android') {
    this.platform = platform;
  }

  readonly leaseLifecycle: LeaseLifecycleProvider = {
    allocate: async (lease) => {
      if (lease.leaseProvider !== this.provider) return undefined;
      const device = this.createDevice(lease);
      const interactor = createFakeProviderInteractor(device, this.calls);
      this.sessionsByLeaseId.set(lease.leaseId, { device, interactor });
      this.calls.push({
        type: 'lease.allocate',
        leaseId: lease.leaseId,
        provider: lease.leaseProvider,
        deviceId: device.id,
      });
      return { provider: this.provider, deviceId: device.id };
    },
    heartbeat: async (lease) => {
      if (lease.leaseProvider !== this.provider) return undefined;
      this.calls.push({
        type: 'lease.heartbeat',
        leaseId: lease.leaseId,
        provider: lease.leaseProvider,
      });
      return { provider: this.provider };
    },
    release: async (lease) => {
      if (lease.leaseProvider !== this.provider) return undefined;
      this.sessionsByLeaseId.delete(lease.leaseId);
      this.calls.push({
        type: 'lease.release',
        leaseId: lease.leaseId,
        provider: lease.leaseProvider,
      });
      return { provider: this.provider };
    },
  };

  readonly deviceInventoryProvider: DeviceInventoryProvider = async (request) => {
    if (request.leaseProvider !== this.provider) return null;
    const leaseId = request.leaseId;
    if (!leaseId) return [];
    const session = this.sessionsByLeaseId.get(leaseId);
    if (!session) return [];
    this.calls.push({
      type: 'inventory',
      leaseId,
      platform: request.platform,
    });
    return [session.device];
  };

  ownsDevice(device: DeviceInfo): boolean {
    return device.id.startsWith(`fake-provider:${this.platform}:`);
  }

  getInteractor(device: DeviceInfo, _runner?: RunnerContext): Interactor | undefined {
    return [...this.sessionsByLeaseId.values()].find((session) => session.device.id === device.id)
      ?.interactor;
  }

  async installApp(
    device: DeviceInfo,
    app: string,
    appPath: string,
  ): Promise<{ packageName: string; appName: string; launchTarget: string } | undefined> {
    if (!this.ownsDevice(device)) return undefined;
    this.calls.push({ type: 'install', deviceId: device.id, app, appPath });
    return {
      packageName: 'com.example.installed',
      appName: 'Installed Demo',
      launchTarget: 'com.example.installed',
    };
  }

  async configurePortReverse(
    options: ProviderPortReverseOptions,
  ): Promise<Record<string, unknown> | undefined> {
    if (options.provider !== this.provider) return undefined;
    this.calls.push({ type: 'portReverse.ensure', options });
    return { provider: this.provider, ...options };
  }

  async shutdown(): Promise<void> {
    this.sessionsByLeaseId.clear();
  }

  deviceIdForLease(leaseId: string): string {
    return `fake-provider:${this.platform}:${leaseId}`;
  }

  private createDevice(lease: DeviceLease): DeviceInfo {
    if (this.platform === 'ios') {
      return {
        platform: 'apple',
        appleOs: 'ios',
        id: this.deviceIdForLease(lease.leaseId),
        name: 'Fake Provider iOS Simulator',
        kind: 'simulator',
        target: 'mobile',
        booted: true,
      };
    }
    return {
      platform: 'android',
      id: this.deviceIdForLease(lease.leaseId),
      name: 'Fake Provider Android',
      kind: 'device',
      target: 'mobile',
      booted: true,
    };
  }
}

function createFakeProviderInteractor(device: DeviceInfo, calls: FakeProviderCall[]): Interactor {
  return new Proxy<Partial<Interactor>>(
    {
      open: async (app, options) => {
        calls.push({ type: 'open', deviceId: device.id, app, url: options?.url });
      },
      close: async (app) => {
        calls.push({ type: 'close', deviceId: device.id, app });
      },
      tap: async (x, y) => {
        calls.push({ type: 'tap', deviceId: device.id, x, y });
        return { backend: 'fake-provider', x, y };
      },
      snapshot: async (options): Promise<SnapshotResult> => {
        calls.push({
          type: 'snapshot',
          deviceId: device.id,
          interactiveOnly: options?.interactiveOnly,
        });
        return {
          backend: 'android',
          producer: 'android-uiautomator',
          nodes: [
            {
              index: 0,
              type: 'TextView',
              label: 'Provider Ready',
              rect: { x: 0, y: 0, width: 120, height: 40 },
              enabled: true,
              visibleToUser: true,
            },
          ],
        };
      },
    },
    {
      get(target, property, receiver) {
        if (property in target) return Reflect.get(target, property, receiver);
        if (
          typeof property === 'string' &&
          ABSENT_FAKE_PROVIDER_INTERACTOR_PROPERTIES.has(property)
        ) {
          return undefined;
        }
        if (typeof property === 'string') {
          return () => throwUnexpectedProviderInteraction(property);
        }
        return undefined;
      },
    },
  ) as Interactor;
}

export function leaseFlags(leaseId?: string): DaemonRequest['flags'] {
  return {
    platform: 'android',
    tenant: 'team-a',
    runId: 'run-a',
    leaseId,
    leaseProvider: FAKE_PROVIDER,
  };
}

export function leaseMeta(leaseId?: string): DaemonRequest['meta'] {
  return {
    tenantId: 'team-a',
    runId: 'run-a',
    leaseId,
    leaseBackend: 'android-instance',
    leaseProvider: FAKE_PROVIDER,
    deviceKey: 'android-a',
    clientId: 'client-a',
  };
}

export function iosLeaseFlags(leaseId?: string): DaemonRequest['flags'] {
  return { ...leaseFlags(leaseId), platform: 'ios' };
}

export function iosLeaseMeta(leaseId?: string): DaemonRequest['meta'] {
  return { ...leaseMeta(leaseId), leaseBackend: 'ios-instance', deviceKey: 'ios-a' };
}

function throwUnexpectedProviderInteraction(method: string): never {
  throw new Error(`Unexpected fake provider interactor call: ${method}`);
}
