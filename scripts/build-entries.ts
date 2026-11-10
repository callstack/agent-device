export const buildEntries = {
  index: 'src/sdk/index.ts',
  io: 'src/sdk/io.ts',
  artifacts: 'src/sdk/artifacts.ts',
  batch: 'src/sdk/batch.ts',
  metro: 'src/sdk/metro.ts',
  'remote-config': 'src/sdk/remote-config.ts',
  'install-source': 'src/sdk/install-source.ts',
  'android-adb': 'src/sdk/android-adb.ts',
  limrun: 'src/sdk/limrun.ts',
  plugins: 'src/sdk/plugins.ts',
  'plugins/webdriver': 'src/sdk/plugin-webdriver.ts',
  contracts: 'src/sdk/contracts.ts',
  selectors: 'src/sdk/selectors.ts',
  finders: 'src/sdk/finders.ts',
  'ai-sdk': 'src/ai-sdk/index.ts',
  'internal/bin': 'src/bin.ts',
  'internal/companion-tunnel': 'packages/react-native/src/companion/companion-tunnel.ts',
  'internal/daemon': 'src/daemon.ts',
  'internal/run-script-http-child': 'packages/maestro/src/daemon-port/run-script-http-child.ts',
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
