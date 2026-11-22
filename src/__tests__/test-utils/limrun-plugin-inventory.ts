import type { PluginInventoryEntry } from '@agent-device/contracts/plugin-inventory';
import { resolveProviderPlugins } from '@agent-device/plugins/registry';
import { limrunPluginCandidate } from './limrun-plugin-store.ts';

/** The inventory one installed Limrun plugin produces, the way the daemon reads it. */
export async function limrunPluginInventory(): Promise<readonly PluginInventoryEntry[]> {
  const resolved = await resolveProviderPlugins([limrunPluginCandidate()]);
  return resolved.inventory();
}
