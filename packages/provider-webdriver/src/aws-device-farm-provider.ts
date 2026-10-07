import {
  AWS_DEVICE_FARM_CAPABILITY_OVERRIDES,
  AWS_DEVICE_FARM_PROFILE_FIELDS,
  createAwsCliDeviceFarmClient,
  createAwsDeviceFarmPrepareSession,
  listAwsDeviceFarmCloudArtifacts,
  readAwsDeviceFarmInteractionMode,
  readAwsDeviceFarmRegionFromArn,
  readAwsDeviceFarmSelectorFromEnv,
  requireAwsDeviceFarmSelector,
} from './aws-device-farm.ts';
import type {
  BundledCloudWebDriverProvider,
  CloudWebDriverConnection,
  CloudWebDriverProviderHost,
  CloudWebDriverProviderOptions,
  CloudWebDriverProviderRegistration,
} from './provider-plugin.ts';
import { CLOUD_WEBDRIVER_PROVIDERS, cloudWebDriverProviderDeclaration } from './providers.ts';
import { readFlag, requireRequest, requireRequestPlatform } from './webdriver-utils.ts';

const PROVIDER = CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm;
const SERVICE = 'AWS Device Farm';

export const awsDeviceFarmProvider: BundledCloudWebDriverProvider = {
  declaration: cloudWebDriverProviderDeclaration(PROVIDER)!,
  create: createAwsDeviceFarmProvider,
};

function createAwsDeviceFarmProvider(
  host: CloudWebDriverProviderHost,
): CloudWebDriverProviderRegistration {
  const { env, runHostCommand } = host;
  const client = (region: string | undefined) =>
    createAwsCliDeviceFarmClient({ runHostCommand, region });
  const webDriver: CloudWebDriverProviderOptions = {
    provider: PROVIDER,
    profileFields: AWS_DEVICE_FARM_PROFILE_FIELDS,
    endpoint: 'http://127.0.0.1/',
    platform: 'android',
    deviceName: 'AWS Device Farm device',
    capabilityOverrides: AWS_DEVICE_FARM_CAPABILITY_OVERRIDES,
    listArtifacts: async ({ provider, providerSessionId }) =>
      await listAwsDeviceFarmCloudArtifacts(
        provider,
        providerSessionId,
        client(
          readAwsDeviceFarmSelectorFromEnv(env, 'awsRegion') ??
            readAwsDeviceFarmRegionFromArn(providerSessionId ?? ''),
        ),
      ),
    prepareSession: async ({ req, lease, base }) => {
      const request = requireRequest(req, SERVICE);
      const platform = requireRequestPlatform(request, SERVICE);
      const selector = (key: 'awsProjectArn' | 'awsDeviceArn') =>
        requireAwsDeviceFarmSelector(readFlag(request, key), env, key, SERVICE);
      return await createAwsDeviceFarmPrepareSession({
        client: client(
          readFlag(request, 'awsRegion') ?? readAwsDeviceFarmSelectorFromEnv(env, 'awsRegion'),
        ),
        projectArn: selector('awsProjectArn'),
        deviceArn: selector('awsDeviceArn'),
        appArn:
          readFlag(request, 'awsAppArn') ?? readAwsDeviceFarmSelectorFromEnv(env, 'awsAppArn'),
        platform,
        deviceName: readFlag(request, 'device') ?? 'AWS Device Farm device',
        sessionName: readFlag(request, 'providerSessionName') ?? lease.leaseId,
        interactionMode: readAwsDeviceFarmInteractionMode(request),
      })({ lease, req, base });
    },
  };
  const connect = async () =>
    (await import('./aws-device-farm-connection.ts')).createAwsDeviceFarmConnection(host);
  const connection: CloudWebDriverConnection = {
    resolve: async (context) => (await connect()).resolve(context),
    verify: async (context) => await (await connect()).verify(context),
  };
  return { webDriver, connection };
}
