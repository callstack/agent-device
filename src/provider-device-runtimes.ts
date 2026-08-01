import type { DefaultCloudWebDriverProviderRuntimeEnv } from '@agent-device/provider-webdriver';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { LIMRUN_PROVIDER } from '@agent-device/provider-limrun';
import { providerWebDriver } from './provider-webdriver.ts';

export type DefaultProviderDeviceRuntimeEnv = DefaultCloudWebDriverProviderRuntimeEnv &
  NodeJS.ProcessEnv;

export const DEFAULT_PROVIDER_RUNTIME_REQUIRED_IDS = [
  ...providerWebDriver.providerIds,
  'limrun' satisfies typeof LIMRUN_PROVIDER,
] as const;

export async function createDefaultProviderDeviceRuntimes(
  env: DefaultProviderDeviceRuntimeEnv = process.env,
): Promise<ProviderDeviceRuntime[]> {
  const runtimes = providerWebDriver.createDefaultRuntimes(env);
  const apiKey = env.LIMRUN_API_KEY?.trim();
  if (!apiKey) return runtimes;

  const { LimrunRuntime } = await import('./provider-limrun-runtime.ts');
  return [
    ...runtimes,
    new LimrunRuntime({
      apiKey,
      region: env.LIMRUN_REGION?.trim() || undefined,
    }),
  ];
}
