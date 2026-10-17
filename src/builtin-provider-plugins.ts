import type { AgentDevicePlugin } from '@agent-device/plugins/contract';
import type { PluginCandidate } from '@agent-device/plugins/registry';
import {
  CLOUD_WEBDRIVER_PROVIDER_DECLARATIONS,
  type CloudWebDriverProviderDeclaration,
} from '@agent-device/provider-webdriver/providers';
import { LIMRUN_ID } from './builtin-provider-ids.ts';
import type { EnvMap } from '@agent-device/kernel/source-value';
import {
  limrunCredentialDeclaration,
  readLimrunCredentials,
  type LimrunCredentials,
} from './provider-limrun-credentials.ts';

/**
 * The built-in providers as registry candidates, in the shape a plugin has. Their implementations
 * load only when a runtime is set up; a candidate that needs configuration claims its id without
 * registering until the environment holds it.
 */
export function builtinProviderCandidates(env: EnvMap): PluginCandidate[] {
  return [
    ...CLOUD_WEBDRIVER_PROVIDER_DECLARATIONS.map((declaration): PluginCandidate => ({
      source: 'builtin',
      provider: declaration.provider,
      load: () => cloudWebDriverPlugin(declaration),
    })),
    limrunCandidate(env),
  ];
}

function cloudWebDriverPlugin(declaration: CloudWebDriverProviderDeclaration): AgentDevicePlugin {
  const loadProvider = async () => {
    const [{ bundledCloudWebDriverProvider }, host] = await Promise.all([
      import('@agent-device/provider-webdriver'),
      import('./provider-webdriver.ts'),
    ]);
    return { bundled: bundledCloudWebDriverProvider(declaration.provider)!, host };
  };
  return {
    apiVersion: 2,
    provider: declaration.provider,
    credentials: { variables: declaration.credentialVariables ?? [] },
    connection: {
      capabilities: declaration.connection,
      resolve: async (context) => {
        const { bundled, host } = await loadProvider();
        return await bundled
          .create(host.createBundledCloudWebDriverHost(context.env))
          .connection.resolve(context);
      },
      verify: async (context) => {
        const { bundled, host } = await loadProvider();
        return await bundled
          .create(host.createBundledCloudWebDriverHost(context.env))
          .connection.verify(context);
      },
    },
    setup: async (pluginHost) => {
      const { bundled, host } = await loadProvider();
      return {
        webDriver: bundled.create(host.createBundledCloudWebDriverHost(pluginHost.env)).webDriver,
      };
    },
  };
}

function limrunCandidate(env: EnvMap): PluginCandidate {
  const base = { source: 'builtin', provider: LIMRUN_ID } as const;
  let credentials: LimrunCredentials | undefined;
  try {
    credentials = readLimrunCredentials(env);
  } catch (error) {
    return { ...base, load: () => Promise.reject(error) };
  }
  if (!credentials) return { ...base, dormant: true, load: () => undefined };
  const limrun = credentials;
  return {
    ...base,
    load: (): AgentDevicePlugin => ({
      apiVersion: 2,
      provider: LIMRUN_ID,
      credentials: limrunCredentialDeclaration(),
      setup: async () => {
        const [runtime, dependencies] = await Promise.all([
          import('@agent-device/provider-limrun'),
          import('./sdk/limrun-runtime-dependencies.ts'),
        ]);
        return runtime.createLimrunRuntime(limrun, dependencies.createLimrunRuntimeDependencies(), {
          includePlatformModule: true,
        });
      },
    }),
  };
}
