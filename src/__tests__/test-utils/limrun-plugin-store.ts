import type { PluginCandidate } from '@agent-device/plugins/registry';

type Store = typeof import('@agent-device/plugins/store');

/** The Limrun package as an installed store plugin, without touching the on-disk store. */
export function limrunPluginCandidate(): PluginCandidate {
  return {
    source: 'store',
    package: '@agent-device/limrun',
    load: async () => (await import('@agent-device/limrun')).default(),
  };
}

/**
 * The plugin store with the workspace Limrun package installed, for a `vi.mock` of
 * `@agent-device/plugins/store`: every reader of the store then sees what a user who ran
 * `plugins add @agent-device/limrun` has.
 */
export async function storeWithLimrunInstalled(
  importOriginal: () => Promise<Store>,
): Promise<Store> {
  const original = await importOriginal();
  return {
    ...original,
    storePluginCandidates: async (env) => [
      ...(await original.storePluginCandidates(env)),
      limrunPluginCandidate(),
    ],
  };
}
