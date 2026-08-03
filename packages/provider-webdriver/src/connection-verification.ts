import type { ProviderWebDriverDependencies } from './dependencies.ts';
import type { ProviderConnectionVerification } from '@agent-device/contracts/remote';
import { verifyAwsDeviceFarmConnection } from './aws-device-farm-connection-verification.ts';
import { verifyBrowserStackConnection } from './browserstack-connection-verification.ts';

export { readAwsDeviceFarmRegionFromArn } from './aws-device-farm-connection-verification.ts';

export type CloudWebDriverConnectionVerification =
  | (ProviderConnectionVerification & {
      provider: 'browserstack';
      service: 'BrowserStack';
      project?: never;
    })
  | (ProviderConnectionVerification & {
      provider: 'aws-device-farm';
      service: 'AWS Device Farm';
      project: { name?: string; reference: string };
    });

export type CloudWebDriverConnectionVerificationOptions =
  | {
      provider: 'browserstack';
      username: string;
      accessKey: string;
      platform: 'android' | 'ios';
      deviceName: string;
      osVersion: string;
      app: string;
      devicesEndpoint?: string | URL;
      appsEndpoint?: string | URL;
    }
  | {
      provider: 'aws-device-farm';
      platform: 'android' | 'ios';
      projectArn: string;
      deviceArn: string;
      appArn?: string;
      region?: string;
    };

export async function verifyCloudWebDriverConnection(
  options: CloudWebDriverConnectionVerificationOptions,
  dependencies: ProviderWebDriverDependencies,
): Promise<CloudWebDriverConnectionVerification> {
  return options.provider === 'browserstack'
    ? await verifyBrowserStackConnection(options, dependencies.clientVersion)
    : await verifyAwsDeviceFarmConnection(options, dependencies.runHostCommand);
}
