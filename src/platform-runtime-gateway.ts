import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import {
  applicationLifecycleOperationFacts,
  createUnavailablePlatformRuntimeBinding,
  createUnavailablePlatformRuntimeFacts,
  providerRuntimeOwner,
  runStartupRecoveryFence,
  runtimeOwnerKey,
  sameRuntimeOwner,
  type DeviceBinding,
  type DeviceBindingRequest,
  type DeviceRuntimeGateway,
  type PlatformRuntimeHost,
  type PlatformRuntimeModule,
  type PlatformRuntimeOperations,
  type PlatformRuntimeOwner,
  type PlatformRuntimeProviderModule,
  type RuntimeOwnerRef,
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

export type PlatformRuntimeProviderRegistration = Readonly<{
  runtime: ProviderDeviceRuntime;
  module: PlatformRuntimeProviderModule;
}>;

export function createComposedPlatformRuntimeGateway(options: {
  modules: ReadonlyMap<Platform, PlatformRuntimeModule>;
  loadHost: () => Promise<PlatformRuntimeHost>;
  providerRuntimes?: readonly ProviderDeviceRuntime[];
  providerModules?: readonly PlatformRuntimeProviderRegistration[];
}): DeviceRuntimeGateway<PlatformRuntimeOperations> {
  const providersByOwner = new Map<string, PlatformRuntimeProviderRegistration>();
  const modulesByRuntime = new Map<ProviderDeviceRuntime, PlatformRuntimeProviderModule>();
  for (const registration of options.providerModules ?? []) {
    const { runtime, module } = registration;
    const key = runtimeOwnerKey(module.owner);
    if (module.owner.provider !== runtime.provider) {
      throw runtimeContractError(`Provider platform runtime metadata is invalid: ${key}`);
    }
    if (providersByOwner.has(key)) {
      throw runtimeContractError(`Duplicate platform runtime owner: ${key}`);
    }
    if (modulesByRuntime.has(runtime)) {
      throw runtimeContractError(`Duplicate platform module registration for ${runtime.provider}`);
    }
    providersByOwner.set(key, registration);
    modulesByRuntime.set(runtime, module);
  }
  const localLoads = new Map<Platform, Promise<PlatformRuntimeOwner>>();
  const providerLoads = new Map<PlatformRuntimeProviderModule, Promise<PlatformRuntimeOwner>>();
  const loadedOwners = new Map<string, PlatformRuntimeOwner>();
  let hostLoad: Promise<PlatformRuntimeHost> | undefined;
  const loadHost = async () => {
    hostLoad ??= options.loadHost();
    try {
      return await hostLoad;
    } catch (error) {
      hostLoad = undefined;
      throw error;
    }
  };
  // Which durable resources exist is the host's composition problem; the gateway only owns the
  // once-per-process shape of each phase and keeps the host load lazy.
  let lifecycleDetach: Promise<void> | undefined;
  let lifecycleFinalize: Promise<void> | undefined;
  const applicationLifecycle = Object.freeze({
    recoverStartupResources: async (input: Readonly<{ stateDir: string }>) => {
      await runStartupRecoveryFence(input.stateDir, async () => {
        await (await loadHost()).applicationResources.recoverStartupResources(input);
      });
    },
    detachForDaemonShutdown: async () => {
      lifecycleDetach ??= loadHost().then(
        async (host) => await host.applicationResources.detachForDaemonShutdown(),
      );
      await lifecycleDetach;
    },
    finalizeDaemonShutdown: async () => {
      lifecycleFinalize ??= loadHost().then(
        async (host) => await host.applicationResources.finalizeDaemonShutdown(),
      );
      await lifecycleFinalize;
    },
  });
  const registerOwner = (owner: PlatformRuntimeOwner) => {
    const key = runtimeOwnerKey(owner.owner);
    const existing = loadedOwners.get(key);
    if (existing && existing !== owner) {
      throw runtimeContractError(`Duplicate platform runtime owner: ${key}`);
    }
    loadedOwners.set(key, owner);
    return owner;
  };
  const loadLocal = async (family: Platform) => {
    const existing = localLoads.get(family);
    if (existing) return await existing;
    const module = options.modules.get(family);
    if (!module) throw runtimeContractError(`Missing platform runtime module for ${family}`);
    if (module.family !== family) {
      throw runtimeContractError(
        `Platform runtime module registered for ${family} declares ${module.family}`,
      );
    }
    const pending = loadHost().then(async (host) => {
      const owner = await module.loadRuntime(host);
      if (owner.owner.kind !== 'local-family' || owner.owner.family !== family) {
        throw runtimeContractError(
          `Platform runtime module for ${family} returned a different local owner`,
        );
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
  const loadProvider = async (module: PlatformRuntimeProviderModule) => {
    const existing = providerLoads.get(module);
    if (existing) return await existing;
    const pending = loadHost().then(async (host) => {
      const owner = await module.loadRuntime(host);
      if (!sameRuntimeOwner(owner.owner, module.owner)) {
        throw runtimeContractError(
          'Provider platform runtime returned a different advertised owner',
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
    applicationLifecycle,
    inspectFacts: async (device) => {
      const provider = selectOrdinaryProvider(options.providerRuntimes, device);
      if (provider) {
        const module = modulesByRuntime.get(provider);
        if (!module) return unavailableProviderFacts(provider, device);
        const owner = await loadProvider(module);
        return await inspectAndValidate(owner, device);
      }
      return await inspectAndValidate(await loadLocal(device.platform), device);
    },
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
      const provider = selectOrdinaryProvider(options.providerRuntimes, request.device);
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

function selectOrdinaryProvider(
  runtimes: readonly ProviderDeviceRuntime[] | undefined,
  device: DeviceInfo,
): ProviderDeviceRuntime | undefined {
  const matching = (runtimes ?? []).filter((runtime) => runtime.ownsDevice(device));
  if (matching.length > 1) {
    throw runtimeContractError('Multiple provider runtimes claim the selected device');
  }
  return matching[0];
}

async function inspectAndValidate(owner: PlatformRuntimeOwner, device: DeviceInfo) {
  const facts = await owner.inspectFacts(device);
  if (!factsMatchDeviceOwner(device, owner.owner, facts)) {
    throw runtimeContractError('Platform runtime facts do not match the selected device and owner');
  }
  return facts;
}

async function bindAndValidate(
  owner: PlatformRuntimeOwner,
  request: DeviceBindingRequest,
): Promise<DeviceBinding<PlatformRuntimeOperations>> {
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
  selected: PlatformRuntimeOwner,
  binding: DeviceBinding<PlatformRuntimeOperations>,
  request: DeviceBindingRequest,
): string | undefined {
  if (!sameRuntimeOwner(binding.owner, selected.owner)) {
    return 'Platform binding returned a different owner than the selected runtime';
  }
  if (!matchesRequestedOwner(binding.owner, request)) {
    return 'Exact platform binding returned a different persisted owner';
  }
  if (!sameDeviceIdentity(deviceIdentity(binding.device), deviceIdentity(request.device))) {
    return 'Platform binding returned a different device identity';
  }
  if (!factsMatchBindingIdentity(binding)) {
    return 'Platform binding facts do not match its device and owner';
  }
  return undefined;
}

function matchesRequestedOwner(owner: RuntimeOwnerRef, request: DeviceBindingRequest): boolean {
  return request.intent.kind !== 'exact-owner' || sameRuntimeOwner(owner, request.intent.owner);
}

function factsMatchBindingIdentity(binding: DeviceBinding<PlatformRuntimeOperations>): boolean {
  return factsMatchDeviceOwner(binding.device, binding.owner, binding.facts);
}

function factsMatchDeviceOwner(
  device: DeviceInfo,
  owner: RuntimeOwnerRef,
  facts: DeviceBinding<PlatformRuntimeOperations>['facts'],
): boolean {
  return (
    sameDeviceShape(facts.device, deviceShape(device)) &&
    providerModeMatchesOwner(facts.device.providerMode, owner)
  );
}

function providerModeMatchesOwner(
  mode: DeviceBinding<PlatformRuntimeOperations>['facts']['device']['providerMode'],
  owner: RuntimeOwnerRef,
): boolean {
  return owner.kind === 'local-family'
    ? mode === 'local' || mode === 'transport-composed'
    : mode === 'provider-runtime';
}

async function selectExactOwner(
  ref: RuntimeOwnerRef,
  providersByOwner: ReadonlyMap<string, PlatformRuntimeProviderRegistration>,
  loadProvider: (module: PlatformRuntimeProviderModule) => Promise<PlatformRuntimeOwner>,
  loadLocal: (family: Platform) => Promise<PlatformRuntimeOwner>,
): Promise<PlatformRuntimeOwner> {
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
): DeviceBinding<PlatformRuntimeOperations> {
  const owner = providerRuntimeOwner(runtime.provider, 'default');
  const unavailable = Object.freeze({
    available: false,
    reason: 'unsupported-provider-mode',
  });
  return createUnavailablePlatformRuntimeBinding(device, owner, {
    appLog: unavailable,
    appState: unavailable,
    network: unavailable,
    screenshot: unavailable,
    viewport: unavailable,
    focus: unavailable,
    elementText: unavailable,
    lifecycle: unavailableProviderLifecycleFacts(unavailable),
  });
}

function unavailableProviderFacts(runtime: ProviderDeviceRuntime, device: DeviceInfo) {
  const unavailable = Object.freeze({
    available: false,
    reason: 'unsupported-provider-mode',
  } as const);
  return createUnavailablePlatformRuntimeFacts(
    device,
    providerRuntimeOwner(runtime.provider, 'default'),
    {
      appLog: unavailable,
      appState: unavailable,
      network: unavailable,
      screenshot: unavailable,
      viewport: unavailable,
      focus: unavailable,
      elementText: unavailable,
      readiness: unavailable,
      lifecycle: unavailableProviderLifecycleFacts(unavailable),
    },
  );
}

/** Missing provider modules must fail closed per operation, never via a shared lifecycle bucket. */
function unavailableProviderLifecycleFacts(
  unavailable: Extract<
    DeviceBinding<PlatformRuntimeOperations>['facts']['operations'][keyof PlatformRuntimeOperations],
    { available: false }
  >,
) {
  return applicationLifecycleOperationFacts({
    resolveOpenTarget: unavailable,
    prepareApplicationOpen: unavailable,
    openApplication: unavailable,
    applyRuntimeHints: unavailable,
    clearRuntimeHints: unavailable,
    closeApplication: unavailable,
    finalizeApplicationClose: unavailable,
    prepareAppleRunner: unavailable,
    configureProviderPortReverse: unavailable,
  });
}

function ownerUnavailable(owner: RuntimeOwnerRef): AppError {
  return new AppError('UNSUPPORTED_OPERATION', 'The exact platform runtime owner is unavailable.', {
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
