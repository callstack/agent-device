import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOwner,
  PlatformRuntimeProviderModule,
} from '@agent-device/contracts/platform-runtime-operations';
import type { PlatformRuntimeProviderRegistration } from '../../../src/platform-runtime-gateway.ts';

/**
 * Test-only owner inference for scenario runtimes that are not built through the plugin registry.
 * The daemon takes each runtime's platform module from the plugin's `setup` result instead; this
 * infers an equivalent module from a fixture runtime that carries `owner` and `loadRuntime`, so a
 * harness-built gateway can classify provider-owned devices. Runtimes without them are skipped.
 */
export function createProviderPlatformRuntimeRegistrations(
  runtimes: readonly ProviderDeviceRuntime[],
): readonly PlatformRuntimeProviderRegistration[] {
  return Object.freeze(
    runtimes.flatMap((runtime) =>
      hasPlatformRuntimeModule(runtime)
        ? [{ runtime, module: providerPlatformRuntimeModule(runtime) }]
        : [],
    ),
  );
}

type ProviderRuntimeWithPlatformModule = ProviderDeviceRuntime &
  Readonly<{
    owner: PlatformRuntimeProviderModule['owner'];
    loadRuntime(host: PlatformRuntimeHost): Promise<PlatformRuntimeOwner>;
  }>;

function hasPlatformRuntimeModule(
  runtime: ProviderDeviceRuntime,
): runtime is ProviderRuntimeWithPlatformModule {
  if (!('owner' in runtime) || !('loadRuntime' in runtime)) return false;
  const owner = runtime.owner;
  return (
    typeof runtime.loadRuntime === 'function' &&
    isProviderRuntimeOwner(owner) &&
    owner.provider === runtime.provider
  );
}

function isProviderRuntimeOwner(owner: unknown): owner is PlatformRuntimeProviderModule['owner'] {
  return (
    typeof owner === 'object' &&
    owner !== null &&
    'kind' in owner &&
    owner.kind === 'provider-runtime' &&
    'provider' in owner &&
    typeof owner.provider === 'string' &&
    'instance' in owner &&
    typeof owner.instance === 'string'
  );
}

function providerPlatformRuntimeModule(
  runtime: ProviderRuntimeWithPlatformModule,
): PlatformRuntimeProviderModule {
  return Object.freeze({
    owner: runtime.owner,
    loadRuntime: async (host) => await runtime.loadRuntime(host),
  });
}
