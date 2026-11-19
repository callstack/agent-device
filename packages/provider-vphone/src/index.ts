import type {
  AgentDevicePlugin,
  PluginConnectionContext,
  ProviderPluginHost,
} from 'agent-device/plugins';
import { createVphoneConnection, VPHONE_PROVIDER, vphoneTransportOptions } from './connection.ts';
import type { VphoneTransportOptions } from './transport.ts';

export type VphoneOptions = VphoneTransportOptions;

export const VPHONE_CONNECTION_CAPABILITIES = Object.freeze({
  leaseKind: 'direct-device-provider' as const,
  requiresAppAttachment: false,
  requiresRemoteDaemon: false,
  supportsArtifacts: false,
  supportsDeferredAppSelection: false,
  supportsDirectPortReverse: false,
  usesCloudWebDriverLease: false,
});

function vphone(options: VphoneOptions = {}): AgentDevicePlugin {
  return Object.freeze({
    apiVersion: 2,
    provider: VPHONE_PROVIDER,
    credentials: { variables: [] },
    connection: Object.freeze({
      capabilities: VPHONE_CONNECTION_CAPABILITIES,
      resolve: (context: PluginConnectionContext) =>
        createVphoneConnection(vphoneTransportOptions(context.host, options)).resolve(context),
      verify: async (context: Pick<PluginConnectionContext, 'flags' | 'env' | 'host'>) =>
        await createVphoneConnection(vphoneTransportOptions(context.host, options)).verify(context),
    }),
    setup: async (host: ProviderPluginHost) => {
      const { createVphoneRuntime } = await import('./runtime.ts');
      return createVphoneRuntime(vphoneTransportOptions(host, options));
    },
  });
}

export { vphone as default };
