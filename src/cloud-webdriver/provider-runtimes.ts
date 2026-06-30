import type { ProviderDeviceRuntime } from '../provider-device-runtime.ts';
import {
  CLOUD_WEBDRIVER_PROVIDER_DEFINITIONS,
  type DefaultCloudWebDriverProviderRuntimeEnv,
} from './provider-definitions.ts';

export type { DefaultCloudWebDriverProviderRuntimeEnv } from './provider-definitions.ts';

export function createDefaultCloudWebDriverProviderRuntimes(
  env: DefaultCloudWebDriverProviderRuntimeEnv = process.env,
): ProviderDeviceRuntime[] {
  return CLOUD_WEBDRIVER_PROVIDER_DEFINITIONS.map((definition) => definition.createRuntime(env));
}
