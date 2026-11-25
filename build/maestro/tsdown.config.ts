import { defineConfig } from 'tsdown';
import { fileURLToPath } from 'node:url';
import { jpegDecoderOnly } from '@agent-device/build-config';
import { bundledLicenseNotices } from '../../scripts/lib/bundled-license-notices.ts';

export default defineConfig({
  cwd: fileURLToPath(new URL('../../packages/maestro', import.meta.url)),
  plugins: [
    jpegDecoderOnly(),
    bundledLicenseNotices(fileURLToPath(new URL('../..', import.meta.url))),
  ],
  entry: {
    'agent-device': 'src/plugin.ts',
    'png-worker': '../capture-kit/src/png-worker.ts',
    'run-script-child': 'src/daemon-port/run-script-child.ts',
    'run-script-http-child': 'src/daemon-port/run-script-http-child.ts',
  },
  outDir: 'dist',
  tsconfig: '../../tsconfig.lib.json',
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  minify: true,
  dts: true,
  hash: false,
  deps: {
    neverBundle: ['agent-device/plugins'],
    alwaysBundle: [/^@agent-device\//],
    onlyBundle: ['yaml', 'undici', 'ipaddr.js', 'pngjs', 'jpeg-js'],
  },
  inputOptions: {
    onLog(level, log, handler) {
      if (log.code === 'UNRESOLVED_IMPORT') throw new Error(log.message);
      handler(level, log);
    },
  },
});
