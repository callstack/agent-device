import type { DefaultCloudWebDriverProviderRuntimeEnv } from '@agent-device/provider-webdriver';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { LIMRUN_PROVIDER } from '@agent-device/provider-limrun';
import type { PlatformRuntimeProviderRegistration } from './platform-runtime-gateway.ts';
import { providerWebDriver } from './provider-webdriver.ts';

export type DefaultProviderDeviceRuntimeEnv = DefaultCloudWebDriverProviderRuntimeEnv &
  NodeJS.ProcessEnv;

export const DEFAULT_PROVIDER_RUNTIME_REQUIRED_IDS = [
  ...providerWebDriver.providerIds,
  'limrun' satisfies typeof LIMRUN_PROVIDER,
] as const;

export type DefaultProviderRuntimeComposition = Readonly<{
  runtimes: readonly ProviderDeviceRuntime[];
  platformModules: readonly PlatformRuntimeProviderRegistration[];
}>;

export async function createDefaultProviderRuntimeComposition(
  env: DefaultProviderDeviceRuntimeEnv = process.env,
): Promise<DefaultProviderRuntimeComposition> {
  const runtimes = providerWebDriver.createDefaultRuntimes(env);
  const apiKey = env.LIMRUN_API_KEY?.trim();
  if (!apiKey) return Object.freeze({ runtimes, platformModules: [] });

  const [limrunRuntime, dependencies] = await Promise.all([
    import('@agent-device/provider-limrun'),
    import('./sdk/limrun-runtime-dependencies.ts'),
  ]);
  const registration = limrunRuntime.createLimrunRuntime(
    {
      apiKey,
      region: env.LIMRUN_REGION?.trim() || undefined,
    },
    dependencies.createLimrunRuntimeDependencies(),
    { includePlatformModule: true },
  );
  return Object.freeze({
    runtimes: Object.freeze([...runtimes, registration.runtime]),
    platformModules: Object.freeze([
      { runtime: registration.runtime, module: registration.platformModule },
    ]),
  });
}
