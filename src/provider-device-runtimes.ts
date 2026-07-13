import { createDefaultCloudWebDriverProviderRuntimes } from './cloud-webdriver/provider-runtimes.ts';
import type { DefaultCloudWebDriverProviderRuntimeEnv } from './cloud-webdriver/provider-runtimes.ts';
import type { ProviderDeviceRuntime } from './provider-device-runtime.ts';
import { createLimrunRuntimeFromEnv } from './providers/limrun/runtime.ts';

export type DefaultProviderDeviceRuntimeEnv = DefaultCloudWebDriverProviderRuntimeEnv &
  NodeJS.ProcessEnv;

export function createDefaultProviderDeviceRuntimes(
  env: DefaultProviderDeviceRuntimeEnv = process.env,
): ProviderDeviceRuntime[] {
  return [
    ...createDefaultCloudWebDriverProviderRuntimes(env),
    createLimrunRuntimeFromEnv(env),
  ].filter((runtime): runtime is ProviderDeviceRuntime => Boolean(runtime));
}
