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
          index: 'src/index.ts',
          io: 'src/io.ts',
          artifacts: 'src/artifacts.ts',
          batch: 'src/batch.ts',
          metro: 'src/metro/metro.ts',
          'remote-config': 'src/remote-config.ts',
          'install-source': 'src/install-source.ts',
          'android-adb': 'src/android-adb.ts',
          'android-snapshot-helper': 'src/android-snapshot-helper.ts',
          contracts: 'src/kernel/contracts.ts',
          selectors: 'src/selectors.ts',
          finders: 'src/finders.ts',
          'internal/bin': 'src/bin.ts',
          'internal/companion-tunnel': 'src/companion-tunnel.ts',
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
