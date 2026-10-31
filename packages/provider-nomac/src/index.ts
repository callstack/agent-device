import type { AgentDevicePlugin, ProviderPluginHost } from 'agent-device/plugins';
import { NOMAC_BASE_URL_VARIABLE, NOMAC_CREDENTIAL_VARIABLE } from './connection.ts';
import { NOMAC_PROVIDER } from './device.ts';

export type NomacPluginOptions = {
  /** Used instead of `NOMAC_API_KEY` when set. */
  apiKey?: string;
  /** NoMac's address; https://nomac.app unless `NOMAC_API_URL` or this says otherwise. */
  baseUrl?: string;
  /** The phone's limits: its longest run, its idle timeout and its spend cap; NoMac's defaults when left out. */
  maxDurationSeconds?: number;
  idleTimeoutSeconds?: number;
  spendCapMicrounits?: string;
};

const loadConnection = async () => await import('./connection.ts');

/**
 * NoMac Simulator as an agent-device provider: an iPhone or iPad Simulator on a NoMac Mac per lease,
 * billed per minute by NoMac. The key comes from `options.apiKey`, else `NOMAC_API_KEY`, and NoMac's
 * address from `options.baseUrl`, else `NOMAC_API_URL`. The daemon fingerprints only the variables the
 * plugin still reads from the environment: the key and the address, unless the options carry them.
 */
function nomac(options: NomacPluginOptions = {}): AgentDevicePlugin {
  // The options stand in for the environment in every callback: connect, verify and the runtime.
  const withKey = (host: ProviderPluginHost): ProviderPluginHost =>
    options.apiKey || options.baseUrl
      ? {
          ...host,
          env: {
            ...host.env,
            ...(options.apiKey ? { [NOMAC_CREDENTIAL_VARIABLE]: options.apiKey } : {}),
            ...(options.baseUrl ? { [NOMAC_BASE_URL_VARIABLE]: options.baseUrl } : {}),
          },
        }
      : host;
  return {
    apiVersion: 2,
    provider: NOMAC_PROVIDER,
    credentials: {
      variables: [
        ...(options.apiKey ? [] : [NOMAC_CREDENTIAL_VARIABLE]),
        ...(options.baseUrl ? [] : [NOMAC_BASE_URL_VARIABLE]),
      ],
    },
    connection: {
      capabilities: {
        leaseKind: 'direct-device-provider',
        requiresAppAttachment: false,
        requiresRemoteDaemon: false,
        supportsArtifacts: false,
        // NoMac keeps no uploaded apps to pick at allocation: a phone starts empty and `install` fills it,
        // so `open <bundle id>` allocates like any other command and never passes the app as --provider-app.
        supportsDeferredAppSelection: false,
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
        baseUrl: env[NOMAC_BASE_URL_VARIABLE],
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
