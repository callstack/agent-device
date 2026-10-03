import type { ProviderWebDriverDependencies } from './dependencies.ts';
import type {
  ProviderConnectionVerification,
  ProviderDeviceType,
} from '@agent-device/contracts/remote';
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
    })
  | (ProviderConnectionVerification & {
      provider: 'testmu';
      service: 'TestMu AI';
      project?: never;
    });

/** Credentials plus the exact device, OS, and app a hosted Appium hub session is created with. */
type HubSelectionVerificationOptions = {
  username: string;
  accessKey: string;
  platform: 'android' | 'ios';
  deviceName: string;
  osVersion: string;
  app: string;
  devicesEndpoint?: string | URL;
  appsEndpoint?: string | URL;
};

export type CloudWebDriverConnectionVerificationOptions =
  | (HubSelectionVerificationOptions & { provider: 'browserstack' })
  | (HubSelectionVerificationOptions & {
      provider: 'testmu';
      /** Defaults to `virtual`. */
      deviceType?: ProviderDeviceType;
      /** Base of the catalog API, as `TESTMU_API_ENDPOINT` sets it for the runtime. */
      apiEndpoint?: string | URL;
    })
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
  switch (options.provider) {
    case 'browserstack':
      return await verifyBrowserStackConnection(options, dependencies.clientVersion);
    case 'testmu': {
      // Loaded on demand: the package entry must not grow its eager closure for a new vendor.
      const { verifyTestMuConnection } = await import('./testmu-connection-verification.ts');
      return await verifyTestMuConnection(options, dependencies.clientVersion);
    }
    case 'aws-device-farm':
      return await verifyAwsDeviceFarmConnection(options, dependencies.runHostCommand);
  }
}
