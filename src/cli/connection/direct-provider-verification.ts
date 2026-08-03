import type { CliFlags } from '@agent-device/contracts/command';
import type { CloudWebDriverConnectionVerification } from '@agent-device/provider-webdriver';
import {
  verifyLimrunConnection,
  type LimrunConnectionVerification,
} from '@agent-device/provider-limrun';
import { AppError } from '@agent-device/kernel/errors';
import { providerWebDriver } from '../../provider-webdriver.ts';
import { readVersion } from '../../utils/version.ts';
import type { EnvMap } from '../../utils/env-map.ts';
import type { ConnectProvider } from './provider-policy.ts';

export type DirectProviderConnectionVerification =
  | CloudWebDriverConnectionVerification
  | LimrunConnectionVerification;

export async function verifyDirectProviderConnection(options: {
  provider?: ConnectProvider;
  flags: CliFlags;
  env?: EnvMap;
  cwd?: string;
}): Promise<DirectProviderConnectionVerification | undefined> {
  const env = options.env ?? process.env;
  const flags = options.flags;
  if (options.provider === 'browserstack') {
    return await providerWebDriver.verifyConnection({
      provider: options.provider,
      username: requireValue(
        env.BROWSERSTACK_USERNAME,
        'connect browserstack requires BROWSERSTACK_USERNAME in the environment.',
      ),
      accessKey: requireValue(
        env.BROWSERSTACK_ACCESS_KEY,
        'connect browserstack requires BROWSERSTACK_ACCESS_KEY in the environment.',
      ),
      platform: requireMobilePlatform(flags.platform, options.provider),
      deviceName: requireValue(flags.device, 'connect browserstack requires --device <name>.'),
      osVersion: requireValue(
        flags.providerOsVersion,
        'connect browserstack requires --provider-os-version <version>.',
      ),
      app: requireValue(
        flags.providerApp,
        'connect browserstack requires --provider-app <bs://app-id-or-local-path>.',
      ),
      cwd: options.cwd ?? process.cwd(),
    });
  }
  if (options.provider === 'aws-device-farm') {
    return await providerWebDriver.verifyConnection({
      provider: options.provider,
      platform: requireMobilePlatform(flags.platform, options.provider),
      projectArn: requireValue(
        flags.awsProjectArn,
        'connect aws-device-farm requires --aws-project-arn <arn>.',
      ),
      deviceArn: requireValue(
        flags.awsDeviceArn,
        'connect aws-device-farm requires --aws-device-arn <arn>.',
      ),
      appArn: flags.awsAppArn,
      region: flags.awsRegion,
    });
  }
  if (options.provider === 'limrun') {
    return await verifyLimrunConnection({
      apiKey: requireValue(env.LIMRUN_API_KEY, 'connect limrun requires LIMRUN_API_KEY.'),
      clientVersion: readVersion(),
      platform: requireMobilePlatform(flags.platform, options.provider),
      region: env.LIMRUN_REGION?.trim() || undefined,
    });
  }
  return undefined;
}

function requireMobilePlatform(
  platform: CliFlags['platform'],
  provider: string,
): 'android' | 'ios' {
  if (platform === 'android' || platform === 'ios') return platform;
  throw new AppError('INVALID_ARGS', `connect ${provider} requires --platform ios|android.`);
}

function requireValue(value: string | undefined, message: string): string {
  if (value) return value;
  throw new AppError('INVALID_ARGS', message);
}
