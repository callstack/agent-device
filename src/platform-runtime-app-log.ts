import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type {
  AppLogRuntimeHost,
  AppLogRuntimeOperations,
  AppLogRuntimePlatformModule,
  AppLogRuntimeProviderModule,
  DeviceBinding,
  DeviceBindingRequest,
  DeviceRuntimeGateway,
  DeviceRuntimeOwner,
  RuntimeOwnerRef,
} from '@agent-device/contracts/platform';
import { createUnavailableAppLogBinding } from '@agent-device/capture-kit';
import {
  providerRuntimeOwner,
  runtimeOwnerKey,
  sameRuntimeOwner,
} from '@agent-device/contracts/platform';
import {
  deviceIdentity,
  deviceShape,
  sameDeviceIdentity,
  sameDeviceShape,
  type DeviceInfo,
  type Platform,
} from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

export type AppLogRuntimeProviderRegistration = Readonly<{
  runtime: ProviderDeviceRuntime;
  module: AppLogRuntimeProviderModule;
}>;

export function createComposedAppLogRuntimeGateway(options: {
  modules: ReadonlyMap<Platform, AppLogRuntimePlatformModule>;
  loadHost: () => Promise<AppLogRuntimeHost>;
  providerRuntimes?: readonly ProviderDeviceRuntime[];
  providerModules?: readonly AppLogRuntimeProviderRegistration[];
}): DeviceRuntimeGateway<AppLogRuntimeOperations> {
  const providersByOwner = new Map<string, AppLogRuntimeProviderRegistration>();
  const modulesByRuntime = new Map<ProviderDeviceRuntime, AppLogRuntimeProviderModule>();
  for (const registration of options.providerModules ?? []) {
    const { runtime, module } = registration;
    const key = runtimeOwnerKey(module.owner);
    if (module.owner.provider !== runtime.provider) {
      throw runtimeContractError(`Provider app-log runtime metadata is invalid: ${key}`);
    }
    if (providersByOwner.has(key)) {
      throw runtimeContractError(`Duplicate app-log runtime owner: ${key}`);
    }
    if (modulesByRuntime.has(runtime)) {
      throw runtimeContractError(`Duplicate app-log module registration for ${runtime.provider}`);
    }
    providersByOwner.set(key, registration);
    modulesByRuntime.set(runtime, module);
  }
  const localLoads = new Map<Platform, Promise<DeviceRuntimeOwner<AppLogRuntimeOperations>>>();
  const providerLoads = new Map<
    AppLogRuntimeProviderModule,
    Promise<DeviceRuntimeOwner<AppLogRuntimeOperations>>
  >();
  const loadedOwners = new Map<string, DeviceRuntimeOwner<AppLogRuntimeOperations>>();
  let hostLoad: Promise<AppLogRuntimeHost> | undefined;
  const loadHost = async () => {
    hostLoad ??= options.loadHost();
    try {
      return await hostLoad;
    } catch (error) {
      hostLoad = undefined;
      throw error;
    }
  };
  const registerOwner = (owner: DeviceRuntimeOwner<AppLogRuntimeOperations>) => {
    const key = runtimeOwnerKey(owner.owner);
    const existing = loadedOwners.get(key);
    if (existing && existing !== owner) {
      throw runtimeContractError(`Duplicate app-log runtime owner: ${key}`);
    }
    loadedOwners.set(key, owner);
    return owner;
  };
  const loadLocal = async (family: Platform) => {
    const existing = localLoads.get(family);
    if (existing) return await existing;
    const module = options.modules.get(family);
    if (!module) throw runtimeContractError(`Missing app-log module for ${family}`);
    if (module.family !== family) {
      throw runtimeContractError(
        `App-log module registered for ${family} declares ${module.family}`,
      );
    }
    const pending = loadHost().then(async (host) => {
      const owner = await module.loadRuntime(host);
      if (owner.owner.kind !== 'local-family' || owner.owner.family !== family) {
        throw runtimeContractError(`App-log module for ${family} returned a different local owner`);
      }
      return registerOwner(owner);
    });
    localLoads.set(family, pending);
    try {
      return await pending;
    } catch (error) {
      if (localLoads.get(family) === pending) localLoads.delete(family);
      throw error;
    }
  };
  const loadProvider = async (module: AppLogRuntimeProviderModule) => {
    const existing = providerLoads.get(module);
    if (existing) return await existing;
    const pending = loadHost().then(async (host) => {
      const owner = await module.loadRuntime(host);
      if (!sameRuntimeOwner(owner.owner, module.owner)) {
        throw runtimeContractError(
          'Provider app-log runtime returned a different advertised owner',
        );
      }
      return registerOwner(owner);
    });
    providerLoads.set(module, pending);
    try {
      return await pending;
    } catch (error) {
      if (providerLoads.get(module) === pending) providerLoads.delete(module);
      throw error;
    }
  };

  return Object.freeze({
    bind: async (request) => {
      if (request.intent.kind === 'exact-owner') {
        const selected = await selectExactOwner(
          request.intent.owner,
          providersByOwner,
          loadProvider,
          loadLocal,
        );
        return await bindAndValidate(selected, request);
      }
      const matchingProviders = (options.providerRuntimes ?? []).filter((runtime) =>
        runtime.ownsDevice(request.device),
      );
      if (matchingProviders.length > 1) {
        throw runtimeContractError('Multiple provider runtimes claim the selected device');
      }
      const provider = matchingProviders[0];
      if (provider) {
        const module = modulesByRuntime.get(provider);
        if (!module) {
          return unavailableProviderBinding(provider, request.device);
        }
        return await bindAndValidate(await loadProvider(module), request);
      }
      return await bindAndValidate(await loadLocal(request.device.platform), request);
    },
    shutdown: async () => {
      await Promise.allSettled(
        [...loadedOwners.values()].map(async (owner) => await owner.shutdown()),
      );
      loadedOwners.clear();
      localLoads.clear();
      providerLoads.clear();
    },
  });
}

async function bindAndValidate(
  owner: DeviceRuntimeOwner<AppLogRuntimeOperations>,
  request: DeviceBindingRequest,
): Promise<DeviceBinding<AppLogRuntimeOperations>> {
  const binding = await owner.bind(request);
  const failure = bindingContractFailure(owner, binding, request);
  if (!failure) return binding;
  let cleanupError: string | undefined;
  try {
    await binding[Symbol.asyncDispose]();
  } catch (error) {
    cleanupError = error instanceof Error ? error.message : String(error);
  }
  throw runtimeContractError(failure, cleanupError);
}

function bindingContractFailure(
  selected: DeviceRuntimeOwner<AppLogRuntimeOperations>,
  binding: DeviceBinding<AppLogRuntimeOperations>,
  request: DeviceBindingRequest,
): string | undefined {
  if (!sameRuntimeOwner(binding.owner, selected.owner)) {
    return 'App-log binding returned a different owner than the selected runtime';
  }
  if (!matchesRequestedOwner(binding.owner, request)) {
    return 'Exact app-log binding returned a different persisted owner';
  }
  if (!sameDeviceIdentity(deviceIdentity(binding.device), deviceIdentity(request.device))) {
    return 'App-log binding returned a different device identity';
  }
  if (!factsMatchBindingIdentity(binding)) {
    return 'App-log binding facts do not match its device and owner';
  }
  return undefined;
}

function matchesRequestedOwner(owner: RuntimeOwnerRef, request: DeviceBindingRequest): boolean {
  return request.intent.kind !== 'exact-owner' || sameRuntimeOwner(owner, request.intent.owner);
}

function factsMatchBindingIdentity(binding: DeviceBinding<AppLogRuntimeOperations>): boolean {
  const { device, owner, facts } = binding;
  return (
    sameDeviceShape(facts.device, deviceShape(device)) &&
    providerModeMatchesOwner(facts.device.providerMode, owner)
  );
}

function providerModeMatchesOwner(
  mode: DeviceBinding<AppLogRuntimeOperations>['facts']['device']['providerMode'],
  owner: RuntimeOwnerRef,
): boolean {
  return owner.kind === 'local-family'
    ? mode === 'local' || mode === 'transport-composed'
    : mode === 'provider-runtime';
}

async function selectExactOwner(
  ref: RuntimeOwnerRef,
  providersByOwner: ReadonlyMap<string, AppLogRuntimeProviderRegistration>,
  loadProvider: (
    module: AppLogRuntimeProviderModule,
  ) => Promise<DeviceRuntimeOwner<AppLogRuntimeOperations>>,
  loadLocal: (family: Platform) => Promise<DeviceRuntimeOwner<AppLogRuntimeOperations>>,
): Promise<DeviceRuntimeOwner<AppLogRuntimeOperations>> {
  if (ref.kind === 'local-family') {
    const owner = await loadLocal(ref.family);
    if (sameRuntimeOwner(owner.owner, ref)) return owner;
    throw ownerUnavailable(ref);
  }
  const registration = providersByOwner.get(runtimeOwnerKey(ref));
  if (registration) return await loadProvider(registration.module);
  throw ownerUnavailable(ref);
}

function unavailableProviderBinding(
  runtime: ProviderDeviceRuntime,
  device: DeviceInfo,
): DeviceBinding<AppLogRuntimeOperations> {
  const owner = providerRuntimeOwner(runtime.provider, 'default');
  return createUnavailableAppLogBinding(device, owner, {
    available: false,
    reason: 'unsupported-provider-mode',
  });
}

function ownerUnavailable(owner: RuntimeOwnerRef): AppError {
  return new AppError('UNSUPPORTED_OPERATION', 'The exact app-log runtime owner is unavailable.', {
    reason: 'owner-unavailable',
    owner: runtimeOwnerKey(owner),
  });
}

function runtimeContractError(message: string, cleanupError?: string): AppError {
  return new AppError('COMMAND_FAILED', message, {
    reason: 'runtime-contract-invalid',
    ...(cleanupError ? { cleanupError } : {}),
  });
}
