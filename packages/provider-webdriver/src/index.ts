import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type {
  CloudArtifactsQuery,
  CloudArtifactsResult,
} from '@agent-device/contracts/observability';
import type { ProviderWebDriverDependencies } from './dependencies.ts';
import {
  createCloudWebDriverProviderDefinitions,
  type DefaultCloudWebDriverArtifactEnv,
  type DefaultCloudWebDriverProviderRuntimeEnv,
} from './provider-definitions.ts';
import { CLOUD_WEBDRIVER_PROVIDERS, isCloudWebDriverProviderName } from './providers.ts';
import {
  readAwsDeviceFarmRegionFromArn,
  verifyCloudWebDriverConnection,
  type CloudWebDriverConnectionVerification,
  type CloudWebDriverConnectionVerificationOptions,
} from './connection-verification.ts';

export { CLOUD_WEBDRIVER_PROVIDERS, isCloudWebDriverProviderName };
export { readAwsDeviceFarmRegionFromArn };
export {
  browserStackOnlyDeviceFeatureFlags,
  rejectBrowserStackOnlyDeviceFeatures,
} from './browserstack-device-features.ts';
export type { CloudWebDriverKnownProviderName } from './providers.ts';
export type { ProviderWebDriverDependencies, RunHostCommand } from './dependencies.ts';
export type {
  DefaultCloudWebDriverArtifactEnv,
  DefaultCloudWebDriverProviderRuntimeEnv,
} from './provider-definitions.ts';
export type {
  CloudWebDriverConnectionVerification,
  CloudWebDriverConnectionVerificationOptions,
} from './connection-verification.ts';

export type ProviderWebDriver = {
  readonly providerIds: readonly string[];
  createDefaultRuntimes(env?: DefaultCloudWebDriverProviderRuntimeEnv): ProviderDeviceRuntime[];
  listArtifactsFromEnv(
    query: CloudArtifactsQuery,
    env: DefaultCloudWebDriverArtifactEnv,
  ): Promise<CloudArtifactsResult | undefined>;
  verifyConnection(
    options: CloudWebDriverConnectionVerificationOptions,
  ): Promise<CloudWebDriverConnectionVerification>;
};

export function createProviderWebDriver(
  dependencies: ProviderWebDriverDependencies,
): ProviderWebDriver {
  const definitions = createCloudWebDriverProviderDefinitions(dependencies);
  return {
    providerIds: definitions.map((definition) => definition.provider),
    createDefaultRuntimes: (env = process.env) =>
      definitions.map((definition) => definition.createRuntime(env)),
    listArtifactsFromEnv: async (query, env) => {
      if (!query.providerSessionId) return undefined;
      return await definitions
        .find((definition) => definition.provider === query.provider)
        ?.listArtifactsFromEnv(query.providerSessionId, env);
    },
    verifyConnection: async (options) =>
      await verifyCloudWebDriverConnection(options, dependencies),
  };
}
