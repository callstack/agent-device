import type { ProviderPluginHost } from 'agent-device/plugins';
import type { CliFlags } from '@agent-device/contracts/command';
import {
  rejectRefusedProviderProfileFields,
  requireResolvedProfilePlatform,
  requireResolvedProfileValue,
} from '@agent-device/contracts/provider-profile-fields';
import { requireConnectPlatform } from '@agent-device/provider-webdriver/plugin';
import {
  readAwsDeviceFarmRegionFromArn,
  readAwsDeviceFarmSelectorFromEnv,
  requireAwsDeviceFarmSelector,
} from './aws-device-farm.ts';
import { AWS_DEVICE_FARM_PROFILE_FIELDS } from './profile-fields.ts';
import { verifyAwsDeviceFarmConnection } from './aws-device-farm-connection-verification.ts';
import { AWS_DEVICE_FARM_PROVIDER } from './providers.ts';

const PROVIDER = AWS_DEVICE_FARM_PROVIDER;
const SERVICE = 'AWS Device Farm';
const CONSUMER = `connect ${PROVIDER}`;

/** The `connect aws-device-farm` callbacks, loaded only when the CLI runs them. */
export function createAwsDeviceFarmConnection(host: ProviderPluginHost) {
  const { env } = host;
  return {
    resolve: ({ flags }: { flags: CliFlags; cwd: string }) => {
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
    verify: async ({ flags }: { flags: CliFlags }) =>
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
        // The plugin drives `aws devicefarm ...` through the host-command capability.
        (command, args) => host.runHostCommand(command, args),
      ),
  };
}
