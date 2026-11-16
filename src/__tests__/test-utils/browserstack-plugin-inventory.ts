import type { PluginInventoryEntry } from '@agent-device/contracts/plugin-inventory';
import type { PluginCandidate } from '@agent-device/plugins/registry';
import { resolveProviderPlugins } from '@agent-device/plugins/registry';
import manifest from '@agent-device/browserstack/package.json' with { type: 'json' };

/** The BrowserStack package as an installed store plugin, without touching the on-disk store. */
export function browserstackPluginCandidate(): PluginCandidate {
  return {
    source: 'store',
    package: manifest.name as string,
    load: async () => (await import('@agent-device/browserstack')).default(),
  };
}

/** The inventory one installed BrowserStack plugin produces, the way the daemon reads it. */
export async function browserstackPluginInventory(): Promise<readonly PluginInventoryEntry[]> {
  const resolved = await resolveProviderPlugins([browserstackPluginCandidate()]);
  return resolved.inventory();
}
