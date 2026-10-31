import type { AgentDevicePlugin, ProviderPluginHost } from 'agent-device/plugins';
import { NOMAC_BASE_URL_VARIABLE, NOMAC_CREDENTIAL_VARIABLE } from './connection.ts';
import { NOMAC_PROVIDER } from './device.ts';

export type NomacPluginOptions = {
  /** Used instead of `NOMAC_API_KEY` when set. */
  apiKey?: string;
  /** NoMac's address; https://nomac.app unless `NOMAC_API_URL` or this says otherwise. */
  baseUrl?: string;
  /** The phone's limits; NoMac's defaults (2 hours, 10 idle minutes, $5 spend cap) when left out. */
  maxDurationSeconds?: number;
  idleTimeoutSeconds?: number;
  spendCapMicrounits?: string;
};

const loadConnection = async () => await import('./connection.ts');

/**
 * NoMac Simulator as an agent-device provider: an iPhone or iPad Simulator on a NoMac Mac per lease,
 * $0.80 an hour by the minute. The key comes from `options.apiKey`, else `NOMAC_API_KEY`; only a key
 * read from the environment is part of the credential fingerprint.
 */
function nomac(options: NomacPluginOptions = {}): AgentDevicePlugin {
  const withKey = (host: ProviderPluginHost): ProviderPluginHost =>
    options.apiKey
      ? { ...host, env: { ...host.env, [NOMAC_CREDENTIAL_VARIABLE]: options.apiKey } }
      : host;
  return {
    apiVersion: 2,
    provider: NOMAC_PROVIDER,
    credentials: { variables: options.apiKey ? [] : [NOMAC_CREDENTIAL_VARIABLE] },
    connection: {
      capabilities: {
        leaseKind: 'direct-device-provider',
        requiresAppAttachment: false,
        requiresRemoteDaemon: false,
        supportsArtifacts: false,
        supportsDeferredAppSelection: true,
        supportsDirectPortReverse: false,
        usesCloudWebDriverLease: false,
      },
      resolve: async (context) =>
        (await loadConnection()).resolveNomacConnection({
          flags: context.flags,
          env: withKey(context.host).env,
        }),
      verify: async (context) =>
        await (
          await loadConnection()
        ).verifyNomacConnection({
          flags: context.flags,
          env: withKey(context.host).env,
          clientVersion: context.host.clientVersion,
        }),
    },
    // No network and no phone here: a lease starts the phone on its first device command.
    setup: async (host) => {
      const env = withKey(host).env;
      const { createNomacRuntime } = await import('./runtime.ts');
      const { runtime, platformModule } = createNomacRuntime({
        apiKey: env[NOMAC_CREDENTIAL_VARIABLE]?.trim() || undefined,
        baseUrl: options.baseUrl ?? env[NOMAC_BASE_URL_VARIABLE],
        clientVersion: host.clientVersion,
        maxDurationSeconds: options.maxDurationSeconds,
        idleTimeoutSeconds: options.idleTimeoutSeconds,
        spendCapMicrounits: options.spendCapMicrounits,
        env: host.env,
      });
      return { runtime, platformModule };
    },
  };
}

export { nomac as default };
