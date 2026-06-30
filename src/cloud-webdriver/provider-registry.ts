import type { CloudArtifactsQuery, CloudArtifactsResult } from '../cloud-artifacts.ts';
import { createAwsCliDeviceFarmClient, listAwsDeviceFarmCloudArtifacts } from './aws-device-farm.ts';
import { listBrowserStackCloudArtifacts } from './browserstack.ts';
import { CLOUD_WEBDRIVER_PROVIDERS } from './providers.ts';
import { AppError } from '../kernel/errors.ts';

export type DefaultCloudWebDriverArtifactEnv = {
  BROWSERSTACK_USERNAME?: string;
  BROWSERSTACK_ACCESS_KEY?: string;
  BROWSERSTACK_SESSION_DETAILS_ENDPOINT?: string;
  AWS_REGION?: string;
  AWS_DEFAULT_REGION?: string;
};

type CloudWebDriverProviderRegistryEntry = {
  provider: string;
  listArtifactsFromEnv: (
    providerSessionId: string,
    env: DefaultCloudWebDriverArtifactEnv,
  ) => Promise<CloudArtifactsResult | undefined>;
};

const CLOUD_WEBDRIVER_PROVIDER_REGISTRY: readonly CloudWebDriverProviderRegistryEntry[] = [
  {
    provider: CLOUD_WEBDRIVER_PROVIDERS.browserStack,
    listArtifactsFromEnv: async (providerSessionId, env) => {
      const username = env.BROWSERSTACK_USERNAME;
      const accessKey = env.BROWSERSTACK_ACCESS_KEY;
      if (!username || !accessKey) {
        throw new AppError(
          'INVALID_ARGS',
          'BrowserStack artifact lookup requires BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY.',
        );
      }
      return await listBrowserStackCloudArtifacts(
        CLOUD_WEBDRIVER_PROVIDERS.browserStack,
        providerSessionId,
        {
          username,
          accessKey,
          endpoint: env.BROWSERSTACK_SESSION_DETAILS_ENDPOINT,
        },
      );
    },
  },
  {
    provider: CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
    listArtifactsFromEnv: async (providerSessionId, env) => {
      const client = createAwsCliDeviceFarmClient({
        region:
          env.AWS_REGION ??
          env.AWS_DEFAULT_REGION ??
          readAwsRegionFromDeviceFarmArn(providerSessionId),
      });
      return await listAwsDeviceFarmCloudArtifacts(
        CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
        providerSessionId,
        client,
      );
    },
  },
];

export async function listCloudWebDriverArtifactsFromEnv(
  query: CloudArtifactsQuery,
  env: DefaultCloudWebDriverArtifactEnv,
): Promise<CloudArtifactsResult | undefined> {
  if (!query.providerSessionId) return undefined;
  const entry = CLOUD_WEBDRIVER_PROVIDER_REGISTRY.find(
    (candidate) => candidate.provider === query.provider,
  );
  return await entry?.listArtifactsFromEnv(query.providerSessionId, env);
}

function readAwsRegionFromDeviceFarmArn(arn: string): string | undefined {
  return /^arn:[^:]+:devicefarm:([^:]+):/.exec(arn)?.[1];
}
