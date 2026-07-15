import { createDefaultCloudWebDriverProviderRuntimes } from './cloud-webdriver/provider-runtimes.ts';
import type { DefaultCloudWebDriverProviderRuntimeEnv } from './cloud-webdriver/provider-runtimes.ts';
import type { ProviderDeviceRuntime } from './provider-device-runtime.ts';

export type DefaultProviderDeviceRuntimeEnv = DefaultCloudWebDriverProviderRuntimeEnv &
  NodeJS.ProcessEnv;

export async function createDefaultProviderDeviceRuntimes(
  env: DefaultProviderDeviceRuntimeEnv = process.env,
): Promise<ProviderDeviceRuntime[]> {
  const runtimes = createDefaultCloudWebDriverProviderRuntimes(env);
  if (!env.LIMRUN_API_KEY?.trim() && !env.LIM_API_KEY?.trim()) return runtimes;

  const { createLimrunRuntimeFromEnv } = await import('./providers/limrun/runtime.ts');
  const limrunRuntime = createLimrunRuntimeFromEnv(env);
  return limrunRuntime ? [...runtimes, limrunRuntime] : runtimes;
}
