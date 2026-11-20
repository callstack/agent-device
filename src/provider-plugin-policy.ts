import type { PluginRegistryPolicy } from '@agent-device/plugins/registry';

export const PROVIDER_PLUGIN_POLICY: PluginRegistryPolicy = Object.freeze({
  hostCapabilities: async (host) =>
    (await import('./provider-plugin-host-capabilities.ts')).createProviderHostCapabilities(host),
});
