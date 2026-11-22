import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { createPluginHost } from '@agent-device/plugins/host';
import { type LimrunRuntimeDependencies } from '@agent-device/limrun/runtime';
import {
  createLimrunAppleToolProvider as createToolProvider,
  createLimrunRuntimeDependencies,
  type LimrunIosHost,
} from '@agent-device/limrun/host';
import { createProviderHostCapabilities } from './provider-plugin-host-capabilities.ts';
import type { DeviceProviderPluginHost } from './sdk/plugin-device-host.ts';

/** The `setup` host the daemon hands an installed provider plugin, built for `host`. */
export async function limrunPluginHost(host: HostEnvironment): Promise<DeviceProviderPluginHost> {
  return await createPluginHost(host, undefined, createProviderHostCapabilities(host));
}

/** The host the Limrun iOS runner modules read, loaded from the root's own Apple owners. */
export async function limrunIosHost(host: HostEnvironment): Promise<LimrunIosHost> {
  const capabilities = createProviderHostCapabilities(host);
  const [pluginHost, apple, kit] = await Promise.all([
    createPluginHost(host, undefined, capabilities),
    capabilities.loadApple(),
    capabilities.loadHostKit(),
  ]);
  return {
    apple,
    kit,
    env: host.env,
    clientVersion: pluginHost.clientVersion,
    emitDiagnostic: pluginHost.diagnostics.emit,
  };
}

/** The runtime adapters the installed plugin builds from the daemon's host, for `host`. */
export async function limrunRuntimeDependencies(
  host: HostEnvironment,
): Promise<LimrunRuntimeDependencies> {
  return await createLimrunRuntimeDependencies(await limrunPluginHost(host));
}

/** The tool provider that reaches a leased Limrun simulator, for suites that scope the Apple tools to it. */
export function createLimrunAppleToolProvider(
  ...args: Parameters<typeof createToolProvider>
): ReturnType<typeof createToolProvider> {
  return createToolProvider(...args);
}
