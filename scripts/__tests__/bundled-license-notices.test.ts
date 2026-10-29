import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'tsdown';
import { test } from 'vitest';
import { mkdtempForTest } from '@agent-device/test-kit';
import { bundledLicenseNotices } from '../lib/bundled-license-notices.ts';

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtempForTest('bundled-licenses-');
  const contents = {
    'package.json': JSON.stringify({ name: 'fixture-project', private: true, type: 'module' }),
    ...files,
  };
  for (const [relative, source] of Object.entries(contents)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, source);
  }
  return root;
}

async function bundle(root: string): Promise<void> {
  await build({
    config: false,
    cwd: root,
    entry: ['input.ts'],
    outDir: 'dist',
    dts: false,
    minify: true,
    deps: { onlyBundle: ['included', 'unused', 'jpeg-js'] },
    plugins: [bundledLicenseNotices(root, path.join(root, 'dist'))],
    logLevel: 'silent',
  });
}

test('bundled licenses retain full license and NOTICE text after minification', async () => {
  const root = await fixture({
    'input.ts': [
      "import { value } from 'included';",
      "import { ignored } from 'unused';",
      "import { external } from 'external';",
      'export const result = value + external;',
    ].join('\n'),
    'node_modules/included/package.json': JSON.stringify({
      name: 'included',
      version: '1.2.3',
      license: 'MIT',
      main: 'index.js',
    }),
    'node_modules/included/index.js':
      "export const value = process.env.FIXTURE_NUMBER ?? 'fixture';",
    'node_modules/included/LICENSE': 'Copyright fixture author\nFull license terms retained.',
    'node_modules/included/NOTICE': 'Upstream attribution retained.',
    'node_modules/unused/package.json': JSON.stringify({
      name: 'unused',
      version: '1.0.0',
      main: 'index.js',
      sideEffects: false,
    }),
    'node_modules/unused/index.js': 'export const ignored = 99;',
    'node_modules/external/package.json': JSON.stringify({
      name: 'external',
      version: '1.0.0',
      main: 'index.js',
    }),
    'node_modules/external/index.js': 'export const external = 1;',
  });
  await bundle(root);
  const notices = await fs.readFile(path.join(root, 'dist/THIRD_PARTY_NOTICES.txt'), 'utf8');
  assert.match(notices, /included/);
  assert.match(notices, /1\.2\.3/);
  assert.match(notices, /Copyright fixture author\nFull license terms retained\./);
  assert.match(notices, /Upstream attribution retained\./);
  assert.doesNotMatch(notices, /unused|external|fixture-project/);
});

test('bundling fails when a dependency has a license identifier but no license text', async () => {
  const root = await fixture({
    'input.ts': "export { value } from 'included';",
    'node_modules/included/package.json': JSON.stringify({
      name: 'included',
      version: '1.0.0',
      license: 'MIT',
      main: 'index.js',
    }),
    'node_modules/included/index.js': 'export const value = 42;',
  });
  await assert.rejects(bundle(root), /included@1\.0\.0 is missing its license or license text/);
});

test('bundled jpeg-js retains source-file notices and the Apache license', async () => {
  const root = await fixture({
    'input.ts': "export { value } from 'jpeg-js';",
    'node_modules/jpeg-js/package.json': JSON.stringify({
      name: 'jpeg-js',
      version: '0.4.4',
      license: 'BSD-3-Clause',
      main: 'index.js',
    }),
    'node_modules/jpeg-js/index.js': 'export const value = process.env.FIXTURE_NUMBER;',
    'node_modules/jpeg-js/LICENSE': 'Package-level BSD terms.',
    'LICENSES/jpeg-js.txt': 'Copyright 2011 notmasteryet\nCopyright 2008 Adobe.',
    'LICENSES/Apache-2.0.txt': 'Full Apache license text.',
  });
  await bundle(root);
  const notices = await fs.readFile(path.join(root, 'dist/THIRD_PARTY_NOTICES.txt'), 'utf8');
  assert.match(notices, /Package-level BSD terms/);
  assert.match(notices, /Copyright 2011 notmasteryet/);
  assert.match(notices, /Copyright 2008 Adobe/);
  assert.match(notices, /Full Apache license text/);
});
