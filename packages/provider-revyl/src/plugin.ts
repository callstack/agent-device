import type { ProviderPluginHost } from 'agent-device/plugins';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { PlatformRuntimeProviderModule } from '@agent-device/contracts/platform-runtime-operations';

/**
 * The version 1 plugin entry, kept so hosts without the version 2 contract still load this package.
 * It returns the runtime and owner directly, plus the connection half the host calls for `connect`.
 */
export default async function revylPlugin(host: ProviderPluginHost) {
  const { requireRevylCredentials } = await import('./credentials.ts');
  const { createRevylRuntime } = await import('./runtime.ts');
  const { createRevylConnection } = await import('./connection.ts');
  const credentials = requireRevylCredentials(host.env, 'Revyl');
  const registration = createRevylRuntime(
    {
      apiKey: credentials.apiKey,
      ...(credentials.apiUrl === undefined ? {} : { backendUrl: credentials.apiUrl }),
      clientVersion: host.clientVersion,
    },
    { includePlatformModule: true },
  );
  return {
    runtime: registration.runtime as ProviderDeviceRuntime,
    platformModule: registration.platformModule as PlatformRuntimeProviderModule,
    connection: createRevylConnection(host),
  };
}
