import { buildEntries } from './scripts/build-entries.ts';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { defineConfig } from 'tsdown';
import { bundledLicenseNotices } from './scripts/lib/bundled-license-notices.ts';

const typeScriptPackageJsonUrl = pathToFileURL(
  createRequire(import.meta.url).resolve('typescript/package.json'),
);
const { default: getTypeScript7ExePath } = await import(
  new URL('lib/getExePath.js', typeScriptPackageJsonUrl).href
);

const packageJson = JSON.parse(
  fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

const publicSdkChunkGroups = [
  [
    'sdk-contracts',
    /packages[\\/]kernel[\\/]src[\\/]contracts\.d\.[cm]?ts$/,
    /packages[\\/]kernel[\\/]src[\\/]contracts\.ts$/,
  ],
  [
    'sdk-errors',
    /packages[\\/]kernel[\\/]src[\\/]errors\.d\.[cm]?ts$/,
    /packages[\\/]kernel[\\/]src[\\/]errors\.ts$/,
  ],
  [
    'sdk-device',
    /packages[\\/]kernel[\\/]src[\\/]device\.d\.[cm]?ts$/,
    /packages[\\/]kernel[\\/]src[\\/]device\.ts$/,
  ],
  [
    'sdk-snapshot',
    /packages[\\/]kernel[\\/]src[\\/]snapshot\.d\.[cm]?ts$/,
    /packages[\\/]kernel[\\/]src[\\/]snapshot\.ts$/,
  ],
  ['sdk-io', /src[\\/]io\.d\.[cm]?ts$/, /src[\\/]io\.ts$/],
  [
    'sdk-batch',
    /packages[\\/]command-registry[\\/]src[\\/]batch-policy\.d\.[cm]?ts$/,
    /packages[\\/]command-registry[\\/]src[\\/]batch-policy\.ts$/,
  ],
  [
    'sdk-batch-runner',
    /packages[\\/]command-registry[\\/]src[\\/]batch\.d\.[cm]?ts$/,
    /packages[\\/]command-registry[\\/]src[\\/]batch\.ts$/,
  ],
  ['sdk-finders', /src[\\/]finders\.d\.[cm]?ts$/, /src[\\/]finders\.ts$/],
  [
    'sdk-remote-config',
    /packages[\\/]remote[\\/]src[\\/]remote-config-schema\.d\.[cm]?ts$/,
    /packages[\\/]remote[\\/]src[\\/]remote-config-schema\.ts$/,
  ],
  ['sdk-selectors', /src[\\/]sdk[\\/]selectors\.d\.[cm]?ts$/, /src[\\/]sdk[\\/]selectors\.ts$/],
] as const;

export default defineConfig({
  entry: buildEntries,
  deps: {
    alwaysBundle: [/^@agent-device\//],
    onlyBundle: [
      '@xmldom/xmldom',
      'agent-base',
      'b4a',
      'debug',
      'events-universal',
      'eventsource-client',
      'eventsource-parser',
      'fast-fifo',
      'has-flag',
      'https-proxy-agent',
      'ignore',
      'ipaddr.js',
      'jpeg-js',
      'ms',
      'pend',
      'plist',
      'pngjs',
      'proxy-from-env',
      'streamx',
      'supports-color',
      'tar-stream',
      'text-decoder',
      'undici',
      'undici-types',
      'ws',
      'xmlbuilder',
      'yaml',
      'yauzl',
    ],
  },
  inputOptions: {
    // A build with missing workspace links resolves nothing under `alwaysBundle` and emits the
    // specifiers as externals instead. That is how 0.20.4 shipped an unresolvable
    // `@agent-device/ad-script` import: rolldown warned, exited 0, and `prepack` packed the result.
    // An unresolved import in a bundle that is supposed to inline its workspace is never a warning.
    onLog(level, log, handler) {
      if (log.code === 'UNRESOLVED_IMPORT') {
        throw new Error(
          `${log.message}\nRun \`pnpm install\` to restore workspace links: unresolved imports would ship as unresolvable externals.`,
        );
      }
      handler(level, log);
    },
  },
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outDir: 'dist/src',
  tsconfig: 'tsconfig.lib.json',
  define: {
    __AGENT_DEVICE_VERSION__: JSON.stringify(packageJson.version),
    __OWNER_FILES__: 'false',
  },
  shims: true,
  hash: false,
  outputOptions: {
    codeSplitting: {
      groups: [
        ...publicSdkChunkGroups.flatMap(([name, dtsTest, jsTest]) => [
          { test: dtsTest, name: `${name}.d` },
          { test: jsTest, name },
        ]),
        // The plugin contract and the host, format-backend and native-execution types it names
        // share this chunk with the replay contracts. Split across two chunks, one declaration file
        // lands in both and TypeScript sees two unrelated types with the same name, so a consumer
        // cannot pass a plugin from one public entry into another entry's function.
        {
          test: /packages[\\/](?:contracts[\\/]src[\\/](?:provider-connection|replay-backend)|plugins[\\/]src[\\/](?:contract|host|replay-backend))\.d\.[cm]?ts$/,
          name: 'sdk-replay-backend.d',
        },
      ],
    },
  },
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  minify: true,
  plugins: [bundledLicenseNotices(import.meta.dirname)],
  dts: {
    tsgo: {
      path: getTypeScript7ExePath(),
    },
  },
});
