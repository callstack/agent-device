import fs from 'node:fs';
import { defineConfig } from 'tsdown';

const typeScriptPackageJsonUrl = import.meta.resolve('typescript/package.json');
const { default: getTypeScript7ExePath } = await import(
  new URL('lib/getExePath.js', typeScriptPackageJsonUrl).href
);

const packageJson = JSON.parse(
  fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

const publicSdkChunkGroups = [
  [
    'sdk-contracts',
    /src[\\/]kernel[\\/]contracts\.d\.[cm]?ts$/,
    /src[\\/]kernel[\\/]contracts\.ts$/,
  ],
  ['sdk-errors', /src[\\/]kernel[\\/]errors\.d\.[cm]?ts$/, /src[\\/]kernel[\\/]errors\.ts$/],
  ['sdk-device', /src[\\/]kernel[\\/]device\.d\.[cm]?ts$/, /src[\\/]kernel[\\/]device\.ts$/],
  ['sdk-snapshot', /src[\\/]kernel[\\/]snapshot\.d\.[cm]?ts$/, /src[\\/]kernel[\\/]snapshot\.ts$/],
  ['sdk-io', /src[\\/]io\.d\.[cm]?ts$/, /src[\\/]io\.ts$/],
  ['sdk-batch', /src[\\/]batch-policy\.d\.[cm]?ts$/, /src[\\/]batch-policy\.ts$/],
  ['sdk-batch-runner', /src[\\/]core[\\/]batch\.d\.[cm]?ts$/, /src[\\/]core[\\/]batch\.ts$/],
  ['sdk-finders', /src[\\/]finders\.d\.[cm]?ts$/, /src[\\/]finders\.ts$/],
  [
    'sdk-android-adb',
    /src[\\/]platforms[\\/]android[\\/]adb-executor\.d\.[cm]?ts$/,
    /src[\\/]platforms[\\/]android[\\/]adb-executor\.ts$/,
  ],
  [
    'sdk-app-inventory',
    /src[\\/]contracts[\\/]app-inventory\.d\.[cm]?ts$/,
    /src[\\/]contracts[\\/]app-inventory\.ts$/,
  ],
  [
    'sdk-remote-config',
    /src[\\/]remote[\\/]remote-config-schema\.d\.[cm]?ts$/,
    /src[\\/]remote[\\/]remote-config-schema\.ts$/,
  ],
  [
    'sdk-selectors',
    /src[\\/]daemon[\\/]selectors-parse\.d\.[cm]?ts$/,
    /src[\\/]daemon[\\/]selectors-parse\.ts$/,
  ],
] as const;

export default defineConfig({
  entry: {
    index: 'src/sdk/index.ts',
    io: 'src/sdk/io.ts',
    artifacts: 'src/sdk/artifacts.ts',
    batch: 'src/sdk/batch.ts',
    metro: 'src/sdk/metro.ts',
    'remote-config': 'src/sdk/remote-config.ts',
    'install-source': 'src/sdk/install-source.ts',
    'android-adb': 'src/sdk/android-adb.ts',
    contracts: 'src/sdk/contracts.ts',
    selectors: 'src/sdk/selectors.ts',
    finders: 'src/sdk/finders.ts',
    'internal/bin': 'src/bin.ts',
    'internal/companion-tunnel': 'src/client/companion-tunnel.ts',
    'internal/daemon': 'src/daemon.ts',
    'internal/png-worker': 'src/utils/png-worker.ts',
    'internal/update-check-entry': 'src/utils/update-check-entry.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outDir: 'dist/src',
  tsconfig: 'tsconfig.lib.json',
  define: {
    __AGENT_DEVICE_VERSION__: JSON.stringify(packageJson.version),
  },
  shims: true,
  hash: false,
  outputOptions: {
    codeSplitting: {
      groups: publicSdkChunkGroups.flatMap(([name, dtsTest, jsTest]) => [
        { test: dtsTest, name: `${name}.d` },
        { test: jsTest, name },
      ]),
    },
  },
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  minify: true,
  dts: {
    tsgo: {
      path: getTypeScript7ExePath(),
    },
  },
});
