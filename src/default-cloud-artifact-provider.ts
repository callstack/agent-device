import type { CloudArtifactProvider, CloudArtifactsResult } from './cloud-artifacts.ts';
import {
  createAwsCliDeviceFarmClient,
  listAwsDeviceFarmCloudArtifacts,
} from './cloud-webdriver/aws-device-farm.ts';
import { listBrowserStackCloudArtifacts } from './cloud-webdriver/browserstack.ts';
import { CLOUD_WEBDRIVER_PROVIDERS } from './cloud-webdriver/providers.ts';
import { AppError } from './kernel/errors.ts';

export type DefaultCloudArtifactProviderEnv = {
  BROWSERSTACK_USERNAME?: string;
  BROWSERSTACK_ACCESS_KEY?: string;
  BROWSERSTACK_SESSION_DETAILS_ENDPOINT?: string;
  AWS_REGION?: string;
  AWS_DEFAULT_REGION?: string;
};

export function createDefaultCloudArtifactProvider(
  env: DefaultCloudArtifactProviderEnv = process.env,
): CloudArtifactProvider {
  return {
    listCloudArtifacts: async (query) => {
      if (!query.providerSessionId) return undefined;
      switch (query.provider) {
        case CLOUD_WEBDRIVER_PROVIDERS.browserStack:
          return await listBrowserStackArtifacts(query.providerSessionId, env);
        case CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm:
          return await listAwsArtifacts(query.providerSessionId, env);
        default:
          return undefined;
      }
    },
  };
}

async function listBrowserStackArtifacts(
  providerSessionId: string,
  env: DefaultCloudArtifactProviderEnv,
): Promise<CloudArtifactsResult | undefined> {
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
}

async function listAwsArtifacts(
  providerSessionId: string,
  env: DefaultCloudArtifactProviderEnv,
): Promise<CloudArtifactsResult | undefined> {
  const client = createAwsCliDeviceFarmClient({
    region:
      env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? readAwsRegionFromDeviceFarmArn(providerSessionId),
  });
  return await listAwsDeviceFarmCloudArtifacts(
    CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
    providerSessionId,
    client,
  );
}

function readAwsRegionFromDeviceFarmArn(arn: string): string | undefined {
  return /^arn:[^:]+:devicefarm:([^:]+):/.exec(arn)?.[1];
}
