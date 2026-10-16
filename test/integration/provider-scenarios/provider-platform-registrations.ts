import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOwner,
  PlatformRuntimeProviderModule,
} from '@agent-device/contracts/platform-runtime-operations';
import type { PlatformRuntimeProviderRegistration } from '../../../src/platform-runtime-gateway.ts';

/**
 * Extracts eager provider-owner metadata without loading a provider implementation, so a
 * harness-built gateway classifies provider-owned devices the way a daemon registering the same
 * runtimes does. Only runtimes that carry a platform module are registered.
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
