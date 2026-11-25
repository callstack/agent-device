export const buildEntries = {
  index: 'src/sdk/index.ts',
  plugins: 'src/sdk/plugins.ts',
  contracts: 'src/sdk/contracts.ts',
  selectors: 'src/sdk/selectors.ts',
  'internal/bin': 'src/bin.ts',
  'internal/companion-tunnel': 'packages/react-native/src/companion/companion-tunnel.ts',
  'internal/daemon': 'src/daemon.ts',
  'internal/png-worker': 'packages/capture-kit/src/png-worker.ts',
  'internal/update-check-entry': 'src/cli/update-check-entry.ts',
} as const;

/**
 * The source files behind `package.json` `exports`: each `./dist/src/<entry>.js` target maps
 * through `buildEntries`. Throws when an export names no build entry.
 */
export function packageEntrySources(
  exportsMap: Readonly<Record<string, { import?: string }>> | undefined,
): string[] {
  return Object.values(exportsMap ?? {})
    .map((entry) => entry.import)
    .filter((target): target is string => typeof target === 'string')
    .map((target) => {
      const key = /^\.\/dist\/src\/(.+)\.js$/.exec(target)?.[1];
      const source =
        key && Object.hasOwn(buildEntries, key)
          ? (buildEntries as Readonly<Record<string, string>>)[key]
          : undefined;
      if (!source) throw new Error(`package export ${target} names no build entry`);
      return source;
    });
}
