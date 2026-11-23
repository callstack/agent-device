import { strictBundlerInputOptions } from '@agent-device/build-config';
import { build } from 'tsdown';

await build({
  config: false,
  entry: 'src/index.ts',
  outDir: 'dist',
  tsconfig: '../../tsconfig.lib.json',
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  minify: true,
  dts: true,
  hash: false,
  deps: { alwaysBundle: [/^@agent-device\//] },
  inputOptions: strictBundlerInputOptions,
});
