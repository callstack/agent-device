import { createDefaultCloudWebDriverProviderRuntimes } from './cloud-webdriver/provider-runtimes.ts';
import { CLOUD_WEBDRIVER_PROVIDER_DEFINITIONS } from './cloud-webdriver/provider-definitions.ts';
import type { DefaultCloudWebDriverProviderRuntimeEnv } from './cloud-webdriver/provider-runtimes.ts';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import { LIMRUN_PROVIDER } from './providers/limrun/device.ts';

export type DefaultProviderDeviceRuntimeEnv = DefaultCloudWebDriverProviderRuntimeEnv &
  NodeJS.ProcessEnv;

export const DEFAULT_PROVIDER_RUNTIME_REQUIRED_IDS = [
  ...CLOUD_WEBDRIVER_PROVIDER_DEFINITIONS.map((definition) => definition.provider),
  LIMRUN_PROVIDER,
] as const;

export async function createDefaultProviderDeviceRuntimes(
  env: DefaultProviderDeviceRuntimeEnv = process.env,
): Promise<ProviderDeviceRuntime[]> {
  const runtimes = createDefaultCloudWebDriverProviderRuntimes(env);
  const apiKey = env.LIMRUN_API_KEY?.trim();
  if (!apiKey) return runtimes;

  const { LimrunRuntime } = await import('./providers/limrun/runtime.ts');
  return [
    ...runtimes,
    new LimrunRuntime({
      apiKey,
      region: env.LIMRUN_REGION?.trim() || undefined,
    }),
  ];
}
