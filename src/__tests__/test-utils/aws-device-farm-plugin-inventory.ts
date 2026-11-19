import type { PluginInventoryEntry } from '@agent-device/contracts/plugin-inventory';
import type { PluginCandidate } from '@agent-device/plugins/registry';
import { resolveProviderPlugins } from '@agent-device/plugins/registry';
import { selectPlugin, pluginSource } from '@agent-device/test-kit';
import awsDeviceFarm from '@agent-device/aws-device-farm';
import manifest from '@agent-device/aws-device-farm/package.json' with { type: 'json' };
import { providerContributionOf } from '@agent-device/plugins/validate';

/** The AWS Device Farm package as an installed store plugin, without touching the on-disk store. */
function awsDeviceFarmPluginCandidate(): PluginCandidate {
  return {
    source: 'store',
    package: manifest.name as string,
    load: async () => (await import('@agent-device/aws-device-farm')).default(),
  };
}

/** The inventory one installed AWS Device Farm plugin produces, the way the daemon reads it. */
export async function awsDeviceFarmPluginInventory(): Promise<readonly PluginInventoryEntry[]> {
  const resolved = await resolveProviderPlugins([awsDeviceFarmPluginCandidate()]);
  return resolved.inventory();
}

/**
 * Declares the plugin installed in a store home, with the capabilities of the real package and a
 * stub connection, so capability readers that prime the store see what an installed plugin declares.
 */
export function selectAwsDeviceFarmPlugin(home: string): void {
  selectPlugin(
    home,
    manifest.name,
    pluginSource('aws-device-farm', {
      extra: `connection: { capabilities: ${JSON.stringify(providerContributionOf(awsDeviceFarm()).connection?.capabilities)}, resolve() {}, verify() {} },`,
    }),
  );
}
