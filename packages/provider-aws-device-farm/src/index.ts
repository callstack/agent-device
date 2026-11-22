import type { ProviderAgentDevicePlugin, ProviderPluginHost } from 'agent-device/plugins';

// The connection and WebDriver code load when they are first used, so importing the package for its
// declaration stays small.
async function loadConnection(host: ProviderPluginHost) {
  return (await import('./connection.ts')).createAwsDeviceFarmConnection(host);
}

/**
 * AWS Device Farm as a plugin. Credentials come from the AWS CLI credential provider chain, which
 * no environment fingerprint identifies, so the plugin declares no credential variables and works
 * with any non-interactive AWS CLI credential source the daemon's host has.
 */
function awsDeviceFarm(): ProviderAgentDevicePlugin {
  return {
    apiVersion: 3,
    contributes: [
      {
        kind: 'provider',
        provider: 'aws-device-farm',
        // The AWS CLI credential chain has no environment fingerprint.
        credentials: { variables: [] },
        connection: {
          capabilities: {
            leaseKind: 'direct-device-provider',
            requiresAppAttachment: true,
            requiresRemoteDaemon: false,
            supportsArtifacts: true,
            supportsDeferredAppSelection: false,
            supportsDirectPortReverse: false,
            usesCloudWebDriverLease: true,
          },
          resolve: async (context) => await (await loadConnection(context.host)).resolve(context),
          verify: async (context) => await (await loadConnection(context.host)).verify(context),
        },
        setup: async (host) =>
          (await import('./aws-device-farm-webdriver.ts')).setupAwsDeviceFarm(host),
      },
    ],
  };
}

export { awsDeviceFarm as default };
