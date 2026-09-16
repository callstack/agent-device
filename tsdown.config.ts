import fs from 'node:fs';
import { defineConfig, type TsdownPluginOption } from 'tsdown';

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
  ['sdk-selectors', /src[\\/]sdk[\\/]selectors\.d\.[cm]?ts$/, /src[\\/]sdk[\\/]selectors\.ts$/],
] as const;

/**
 * Drops the ambient `import '...'` marker `deps.dts.neverBundle` leaves behind, which a
 * published install cannot resolve. Safe only while the name appears nowhere else.
 */
function dropAmbientDeclarationImport(
  fileName: string,
  code: string,
  packageName = '@limrun/api',
): string | null {
  const ambientImport = new RegExp(`^import ["']${packageName}["'];\\n`, 'm');
  if (!ambientImport.test(code)) return null;
  const declarationChunk = code.replace(ambientImport, '');
  if (declarationChunk.includes(packageName)) {
    throw new Error(
      `${fileName} keeps a type reference to ${packageName}, which is dev-bundled and absent from a published install.`,
    );
  }
  return declarationChunk;
}

const dropAmbientDeclarationImports: TsdownPluginOption = {
  name: 'agent-device:drop-ambient-declaration-imports',
  renderChunk(code, chunk) {
    return chunk.fileName.endsWith('.d.ts')
      ? dropAmbientDeclarationImport(chunk.fileName, code)
      : null;
  },
};

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
    limrun: 'src/sdk/limrun.ts',
    contracts: 'src/sdk/contracts.ts',
    selectors: 'src/sdk/selectors.ts',
    finders: 'src/sdk/finders.ts',
    'ai-sdk': 'src/ai-sdk/index.ts',
    'internal/bin': 'src/bin.ts',
    'internal/companion-tunnel': 'src/client/companion-tunnel.ts',
    'internal/daemon': 'src/daemon.ts',
    'internal/run-script-http-child': 'packages/maestro/src/daemon-port/run-script-http-child.ts',
    'internal/png-worker': 'packages/capture-kit/src/png-worker.ts',
    'internal/update-check-entry': 'src/cli/update-check-entry.ts',
  },
  deps: {
    alwaysBundle: [/^@agent-device\//],
    onlyBundle: [
      '@limrun/api',
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
      'ms',
      'pend',
      'pngjs',
      'proxy-from-env',
      'streamx',
      'supports-color',
      'tar-stream',
      'text-decoder',
      'undici',
      'undici-types',
      'ws',
      'yaml',
      'yauzl',
    ],
    // The Limrun SDK is dev-bundled, so a published install has no `@limrun/api` to resolve:
    // the limrun facade declares the session and runtime types consumers may use.
    dts: {
      neverBundle: ['@limrun/api'],
    },
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
  // Limrun loads `@limrun/xdelta3-wasm` only inside `client.syncApp`, which agent-device never
  // calls, so 52 kB of base64 wasm would ship for a path nothing reaches. The alias resolves the
  // specifier to a chunk that names the omission. Add the package to `deps.onlyBundle` and drop
  // this alias to restore that path.
  alias: {
    '@limrun/xdelta3-wasm': new URL('./src/vendor/limrun-delta-sync-omitted.ts', import.meta.url)
      .pathname,
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
      groups: publicSdkChunkGroups.flatMap(([name, dtsTest, jsTest]) => [
        { test: dtsTest, name: `${name}.d` },
        { test: jsTest, name },
      ]),
    },
  },
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  minify: true,
  plugins: [dropAmbientDeclarationImports],
  dts: {
    tsgo: {
      path: getTypeScript7ExePath(),
    },
  },
});
