import type { PluginInventoryEntry } from '@agent-device/contracts/plugin-inventory';
import { resolveProviderPlugins } from '@agent-device/plugins/registry';
import { builtinProviderCandidates } from '../../builtin-provider-plugins.ts';

/**
 * The inventory the built-in providers have after load and validation, with every one of them
 * configured. It does not include setup failures, which only a started registry records.
 */
export async function builtinPluginInventory(): Promise<readonly PluginInventoryEntry[]> {
  const resolved = await resolveProviderPlugins(
    builtinProviderCandidates({ LIMRUN_API_KEY: 'configured' }),
  );
  return resolved.inventory();
}
