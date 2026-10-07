import {
  rejectRefusedProviderProfileFields,
  requireResolvedProfilePlatform,
  requireResolvedProfileValue,
} from '@agent-device/contracts/provider-profile-fields';
import {
  AWS_DEVICE_FARM_PROFILE_FIELDS,
  readAwsDeviceFarmRegionFromArn,
  readAwsDeviceFarmSelectorFromEnv,
  requireAwsDeviceFarmSelector,
} from './aws-device-farm.ts';
import { verifyAwsDeviceFarmConnection } from './connection-verification.ts';
import type {
  CloudWebDriverConnection,
  CloudWebDriverConnectionContext,
  CloudWebDriverConnectProfileResolution,
  CloudWebDriverProviderHost,
} from './provider-plugin.ts';
import { CLOUD_WEBDRIVER_PROVIDERS } from './providers.ts';
import { requireConnectPlatform } from './webdriver-utils.ts';

const PROVIDER = CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm;
const SERVICE = 'AWS Device Farm';
const CONSUMER = `connect ${PROVIDER}`;

/** The `connect aws-device-farm` callbacks, loaded only when the CLI runs them. */
export function createAwsDeviceFarmConnection(host: CloudWebDriverProviderHost): {
  resolve(context: CloudWebDriverConnectionContext): CloudWebDriverConnectProfileResolution;
} & CloudWebDriverConnection {
  const { env } = host;
  return {
    resolve: ({ flags }): CloudWebDriverConnectProfileResolution => {
      rejectRefusedProviderProfileFields(flags, AWS_DEVICE_FARM_PROFILE_FIELDS);
      const platform = requireConnectPlatform(flags, PROVIDER);
      const awsProjectArn = requireAwsDeviceFarmSelector(
        flags.awsProjectArn,
        env,
        'awsProjectArn',
        CONSUMER,
      );
      return {
        profile: {
          leaseProvider: PROVIDER,
          platform,
          device: flags.device,
          awsProjectArn,
          awsDeviceArn: requireAwsDeviceFarmSelector(
            flags.awsDeviceArn,
            env,
            'awsDeviceArn',
            CONSUMER,
          ),
          awsAppArn: flags.awsAppArn ?? readAwsDeviceFarmSelectorFromEnv(env, 'awsAppArn'),
          awsRegion:
            flags.awsRegion ??
            readAwsDeviceFarmSelectorFromEnv(env, 'awsRegion') ??
            readAwsDeviceFarmRegionFromArn(awsProjectArn),
          awsInteractionMode: flags.awsInteractionMode,
          providerSessionName: flags.providerSessionName,
        },
      };
    },
    verify: async ({ flags }) =>
      await verifyAwsDeviceFarmConnection(
        {
          platform: requireResolvedProfilePlatform(flags.platform, SERVICE),
          projectArn: requireResolvedProfileValue(
            flags.awsProjectArn,
            'AWS Device Farm profile missed project ARN.',
          ),
          deviceArn: requireResolvedProfileValue(
            flags.awsDeviceArn,
            'AWS Device Farm profile missed device ARN.',
          ),
          appArn: flags.awsAppArn,
          region: flags.awsRegion,
        },
        host.runHostCommand,
      ),
  };
}
