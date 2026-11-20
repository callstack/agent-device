import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { createPluginHost } from '@agent-device/plugins/host';
import { readVersion } from '@agent-device/host-kit/version';
import { type LimrunRuntimeDependencies } from '@agent-device/limrun/runtime';
import {
  createLimrunAppleToolProvider as createToolProvider,
  createLimrunRuntimeDependencies,
  type LimrunIosHost,
} from '@agent-device/limrun/host';
import { createProviderHostCapabilities } from './provider-plugin-host-capabilities.ts';
import type { DeviceProviderPluginHost } from './sdk/plugin-device-host.ts';

/** The `setup` host the daemon hands an installed provider plugin, built for `host`. */
export function limrunPluginHost(host: HostEnvironment): DeviceProviderPluginHost {
  return createPluginHost(host, undefined, createProviderHostCapabilities(host));
}

/** The host the Limrun iOS runner modules read, loaded from the root's own Apple owners. */
export async function limrunIosHost(host: HostEnvironment): Promise<LimrunIosHost> {
  const capabilities = createProviderHostCapabilities(host);
  const [apple, kit] = await Promise.all([capabilities.loadApple(), capabilities.loadHostKit()]);
  return {
    apple,
    kit,
    env: host.env,
    clientVersion: readVersion(),
    emitDiagnostic: capabilities.emitDiagnostic,
  };
}

/** The runtime adapters the installed plugin builds from the daemon's host, for `host`. */
export async function limrunRuntimeDependencies(
  host: HostEnvironment,
): Promise<LimrunRuntimeDependencies> {
  return await createLimrunRuntimeDependencies(limrunPluginHost(host));
}

/** The tool provider that reaches a leased Limrun simulator, for suites that scope the Apple tools to it. */
export function createLimrunAppleToolProvider(
  ...args: Parameters<typeof createToolProvider>
): ReturnType<typeof createToolProvider> {
  return createToolProvider(...args);
}
