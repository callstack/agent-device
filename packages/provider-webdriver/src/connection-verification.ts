import type { ProviderWebDriverDependencies } from './dependencies.ts';
import { verifyAwsDeviceFarmConnection } from './aws-device-farm-connection-verification.ts';
import { verifyBrowserStackConnection } from './browserstack-connection-verification.ts';

export { readAwsDeviceFarmRegionFromArn } from './aws-device-farm-connection-verification.ts';

export type VerifiedProviderResource = {
  status: 'verified' | 'configured' | 'deferred' | 'missing';
  name?: string;
  reference?: string;
  platform?: 'android' | 'ios';
  osVersion?: string;
  version?: string;
  availability?: string;
  message?: string;
};

export type CloudWebDriverConnectionVerification =
  | {
      provider: 'browserstack';
      service: 'BrowserStack';
      verificationMessage: string;
      device: VerifiedProviderResource;
      app: VerifiedProviderResource;
    }
  | {
      provider: 'aws-device-farm';
      service: 'AWS Device Farm';
      verificationMessage: string;
      project: { name?: string; reference: string };
      device: VerifiedProviderResource;
      app: VerifiedProviderResource;
    };

export type CloudWebDriverConnectionVerificationOptions =
  | {
      provider: 'browserstack';
      username: string;
      accessKey: string;
      platform: 'android' | 'ios';
      deviceName: string;
      osVersion: string;
      app: string;
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
