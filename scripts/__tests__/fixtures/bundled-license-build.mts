import path from 'node:path';
import { build } from 'tsdown';
import { bundledLicenseNotices } from '../../lib/bundled-license-notices.ts';

const root = process.argv[2];
if (!root) throw new Error('Missing license fixture root.');

await build({
  config: false,
  cwd: root,
  tsconfig: path.join(root, 'tsconfig.json'),
  entry: ['input.ts'],
  outDir: process.argv[4] ?? 'dist',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  dts: process.argv[3] === 'true',
  minify: true,
  deps: {
    onlyBundle: [
      'included',
      'omitted',
      'shared',
      'distinct',
      'unused',
      'jpeg-js',
      '@limrun/xdelta3-wasm',
      'included-extra',
      'included.extra',
      'included_extra',
    ],
  },
  plugins: [bundledLicenseNotices(root)],
  logLevel: 'silent',
});
