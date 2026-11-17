import type { ProviderPluginHost } from 'agent-device/plugins';
import type { WebDriverPluginOptions } from 'agent-device/plugins/webdriver';
import {
  readFlag,
  requireRequest,
  requireRequestPlatform,
} from '@agent-device/provider-webdriver/plugin';
import {
  AWS_DEVICE_FARM_CAPABILITY_OVERRIDES,
  createAwsCliDeviceFarmClient,
  createAwsDeviceFarmPrepareSession,
  listAwsDeviceFarmCloudArtifacts,
  readAwsDeviceFarmInteractionMode,
  readAwsDeviceFarmRegionFromArn,
  readAwsDeviceFarmSelectorFromEnv,
  requireAwsDeviceFarmSelector,
} from './aws-device-farm.ts';
import { AWS_DEVICE_FARM_PROFILE_FIELDS } from './profile-fields.ts';
import { AWS_DEVICE_FARM_PROVIDER } from './providers.ts';

const SERVICE = 'AWS Device Farm';

/** The AWS Device Farm WebDriver descriptor the host drives through its shared engine. */
export function createAwsDeviceFarmWebDriver(host: ProviderPluginHost): WebDriverPluginOptions {
  const { env } = host;
  const runHostCommand = (command: string, args: readonly string[]) =>
    host.runHostCommand(command, args);
  const client = (region: string | undefined) =>
    createAwsCliDeviceFarmClient({ runHostCommand, region });
  const webDriver: WebDriverPluginOptions = {
    provider: AWS_DEVICE_FARM_PROVIDER,
    profileFields: AWS_DEVICE_FARM_PROFILE_FIELDS,
    endpoint: 'http://127.0.0.1/',
    platform: 'android',
    deviceName: 'AWS Device Farm device',
    capabilityOverrides: AWS_DEVICE_FARM_CAPABILITY_OVERRIDES,
    listArtifacts: async ({ provider, providerSessionId }) =>
      await listAwsDeviceFarmCloudArtifacts(
        provider,
        providerSessionId,
        // The session ARN names the region the session ran in, which `--aws-region` may have chosen
        // over the environment's region.
        client(
          readAwsDeviceFarmRegionFromArn(providerSessionId ?? '') ??
            readAwsDeviceFarmSelectorFromEnv(env, 'awsRegion'),
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
  return webDriver;
}
