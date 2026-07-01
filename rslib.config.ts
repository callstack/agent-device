import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@rslib/core';

const packageJson = JSON.parse(
  fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig({
  lib: [
    {
      format: 'esm',
      syntax: 'es2022',
      dts: {
        bundle: true,
        tsgo: true,
      },
      shims: {
        esm: {
          __filename: true,
        },
      },
      source: {
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
        tsconfigPath: 'tsconfig.lib.json',
        define: {
          __AGENT_DEVICE_VERSION__: JSON.stringify(packageJson.version),
        },
      },
      output: {
        distPath: {
          root: path.join('dist', 'src'),
        },
        minify: true,
      },
    },
  ],
});
