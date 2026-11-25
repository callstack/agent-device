import { PROVIDER_CREDENTIAL_REASONS } from '@agent-device/kernel/errors';
import type { DeviceProviderPluginHost } from 'agent-device/plugins/device-host';
import type { ProviderAgentDevicePlugin } from 'agent-device/plugins';
import { adcClient, credentials } from './client.ts';
import { formFactor } from './target.ts';

export default function adc(): ProviderAgentDevicePlugin {
  return {
    apiVersion: 3,
    contributes: [
      {
        kind: 'provider',
        provider: 'adc',
        credentials: {
          variables: ['ADC_API_KEY', 'ADC_API_URL', 'ADC_ADB_WEBSOCKET_URL', 'ADC_LEASE_TOKEN'],
        },
        connection: {
          capabilities: {
            leaseKind: 'direct-device-provider',
            requiresAppAttachment: false,
            requiresRemoteDaemon: false,
            supportsArtifacts: false,
            supportsDeferredAppSelection: false,
            supportsDirectPortReverse: false,
            usesCloudWebDriverLease: false,
            holdsCloudDevice: true,
          },
          resolve({ flags, env }) {
            credentials(env);
            const tv = formFactor(flags) === 'tv';
            return {
              profile: { leaseProvider: 'adc', platform: 'android', target: tv ? 'tv' : 'mobile' },
            };
          },
          async verify({ flags, env }) {
            const config = credentials(env);
            const form = formFactor(flags);
            if (config.kind === 'direct') {
              const client = adcClient(config);
              await client.verify();
            }
            return {
              provider: 'adc',
              service: 'ADC',
              verificationMessage:
                config.kind === 'direct'
                  ? 'ADC workspace key verified.'
                  : 'ADC lease endpoint configured.',
              device: {
                status: 'deferred',
                platform: 'android',
                message: `The session will connect to an ADC ${form}.`,
              },
              app: { status: 'missing', message: 'Install an Android build after connecting.' },
            };
          },
        },
        async setup(host: DeviceProviderPluginHost) {
          const { env } = host;
          if (
            ![env.ADC_API_KEY, env.ADC_ADB_WEBSOCKET_URL, env.ADC_LEASE_TOKEN].some((value) =>
              value?.trim(),
            )
          ) {
            return {
              dormant: {
                reason: PROVIDER_CREDENTIAL_REASONS.missing.reason,
                message: 'ADC credentials are missing.',
                hint: 'Set ADC_API_KEY to rent, or ADC_ADB_WEBSOCKET_URL and ADC_LEASE_TOKEN to attach.',
              },
            };
          }
          const config = credentials(env);
          if (!host.loadAndroid) throw new Error('ADC requires the Android plugin host.');
          const android = await host.loadAndroid();
          const { createRegistration } = await import('./runtime.ts');
          return createRegistration(config, env, android);
        },
      },
    ],
  };
}
