import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'vitest';
import { mkdtempForTest } from '@agent-device/test-kit';

const execFileAsync = promisify(execFile);

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await fs.realpath(await mkdtempForTest('bundled-licenses-'));
  const contents = {
    'package.json': JSON.stringify({ name: 'fixture-project', type: 'module' }),
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'es2022', module: 'nodenext', skipLibCheck: true },
      include: ['input.ts'],
    }),
    ...files,
  };
  for (const [relative, source] of Object.entries(contents)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, source);
  }
  return root;
}

async function bundle(root: string, dts = false, outputDirectory = 'dist'): Promise<void> {
  await execFileAsync(process.execPath, [
    '--experimental-strip-types',
    fileURLToPath(new URL('./fixtures/bundled-license-build.mts', import.meta.url)),
    root,
    String(dts),
    outputDirectory,
  ]);
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
      author: 'Fixture author <author@example.test>',
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
  assert.match(notices, /Author: Fixture author <author@example\.test>/);
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

test('identical notices are shared without losing packages or distinct copyrights', async () => {
  const sharedLicense = 'Copyright shared author\nFull shared license terms.';
  const sharedNotice = 'Shared upstream attribution.';
  const distinctLicense = 'Copyright different author\nFull shared license terms.';
  const files: Record<string, string> = {
    'input.ts': [
      "export { value as first } from 'included';",
      "export { value as second } from 'shared';",
      "export { value as third } from 'distinct';",
    ].join('\n'),
  };
  for (const name of ['included', 'shared', 'distinct']) {
    files[`node_modules/${name}/package.json`] = JSON.stringify({
      name,
      version: '1.0.0',
      license: 'MIT',
      main: 'index.js',
    });
    files[`node_modules/${name}/index.js`] = `export const value = process.env.${name};`;
    files[`node_modules/${name}/LICENSE`] = name === 'distinct' ? distinctLicense : sharedLicense;
    files[`node_modules/${name}/NOTICE`] = sharedNotice;
  }
  const root = await fixture(files);
  await bundle(root);
  const notices = await fs.readFile(path.join(root, 'dist/THIRD_PARTY_NOTICES.txt'), 'utf8');
  assert.equal(notices.split(sharedLicense).length - 1, 1);
  assert.equal(notices.split(sharedNotice).length - 1, 1);
  assert.equal(notices.split(distinctLicense).length - 1, 1);
  const references = ['included', 'shared', 'distinct'].map((name) => {
    const line = new RegExp(`^${name}@1\\.0\\.0 \\(MIT\\): (.+)$`, 'm');
    assert.match(notices, line);
    return notices.match(line)?.[1];
  });
  assert.equal(references[0], references[1]);
  assert.notEqual(references[0], references[2]);
  await fs.writeFile(
    path.join(root, 'input.ts'),
    [
      "export { value as third } from 'distinct';",
      "export { value as second } from 'shared';",
      "export { value as first } from 'included';",
    ].join('\n'),
  );
  await bundle(root);
  assert.equal(await fs.readFile(path.join(root, 'dist/THIRD_PARTY_NOTICES.txt'), 'utf8'), notices);
});

test('notice references use code-unit ordering for package names', async () => {
  const names = ['included_extra', 'included-extra', 'included.extra'];
  const files: Record<string, string> = {
    'input.ts': names
      .map((name, index) => `export { value as value${index} } from '${name}';`)
      .join('\n'),
  };
  for (const name of names) {
    files[`node_modules/${name}/package.json`] = JSON.stringify({
      name,
      version: '1.0.0',
      license: 'MIT',
      main: 'index.js',
    });
    files[`node_modules/${name}/index.js`] = `export const value = '${name}';`;
    files[`node_modules/${name}/LICENSE`] = 'Copyright ordering fixture\nShared license terms.';
  }
  const root = await fixture(files);
  await bundle(root);
  const notices = await fs.readFile(path.join(root, 'dist/THIRD_PARTY_NOTICES.txt'), 'utf8');
  assert.equal(
    notices.split('\n\n')[0],
    [
      'included-extra@1.0.0 (MIT): [1]',
      'included.extra@1.0.0 (MIT): [1]',
      'included_extra@1.0.0 (MIT): [1]',
    ].join('\n'),
  );
});

test('declaration generation preserves JavaScript dependency notices', async () => {
  const root = await fixture({
    'input.ts': "export { value } from 'included';",
    'node_modules/included/package.json': JSON.stringify({
      name: 'included',
      version: '1.0.0',
      license: 'MIT',
      main: 'index.js',
      types: 'index.d.ts',
    }),
    'node_modules/included/index.js': "export const value = 'included';",
    'node_modules/included/index.d.ts': 'export declare const value: string;',
    'node_modules/included/LICENSE': 'Copyright included author\nIncluded license terms.',
  });
  await bundle(root);
  const notices = await fs.readFile(path.join(root, 'dist/THIRD_PARTY_NOTICES.txt'), 'utf8');
  assert.match(notices, /included@1\.0\.0/);
  await bundle(root, true);
  assert.ok((await fs.stat(path.join(root, 'dist/input.d.ts'))).size > 0);
  assert.equal(await fs.readFile(path.join(root, 'dist/THIRD_PARTY_NOTICES.txt'), 'utf8'), notices);
});

test.each(['0.4.4', '0.4.5'])(
  'bundled jpeg-js@%s requires matching source-file notices',
  async (version) => {
    const root = await fixture({
      'input.ts': "export { value } from 'jpeg-js';",
      'node_modules/jpeg-js/package.json': JSON.stringify({
        name: 'jpeg-js',
        version,
        license: 'BSD-3-Clause',
        main: 'index.js',
      }),
      'node_modules/jpeg-js/index.js': 'export const value = process.env.FIXTURE_NUMBER;',
      'node_modules/jpeg-js/LICENSE': 'Package-level BSD terms.',
      'LICENSES/jpeg-js.txt':
        'jpeg-js 0.4.4 source-file notices\n\nCopyright 2011 notmasteryet\nCopyright 2008 Adobe.',
      'LICENSES/Apache-2.0.txt': 'Full Apache license text.',
    });
    if (version === '0.4.5') {
      await assert.rejects(bundle(root), /LICENSES\/jpeg-js\.txt.*jpeg-js@0\.4\.5/);
      return;
    }
    await bundle(root);
    const notices = await fs.readFile(path.join(root, 'dist/THIRD_PARTY_NOTICES.txt'), 'utf8');
    assert.match(notices, /Package-level BSD terms/);
    assert.match(notices, /Copyright 2011 notmasteryet/);
    assert.match(notices, /Copyright 2008 Adobe/);
    assert.match(notices, /Full Apache license text/);
  },
);

test('output overrides write notices beside the bundle without creating the default dist', async () => {
  const root = await fixture({
    'input.ts': "export { value } from 'included';",
    'node_modules/included/package.json': JSON.stringify({
      name: 'included',
      version: '1.0.0',
      license: 'MIT',
      main: 'index.js',
    }),
    'node_modules/included/index.js': 'export const value = 42;',
    'node_modules/included/LICENSE': 'Copyright fixture author\nFull license terms.',
  });
  await bundle(root, false, 'redirected');
  assert.match(
    await fs.readFile(path.join(root, 'redirected/THIRD_PARTY_NOTICES.txt'), 'utf8'),
    /included@1\.0\.0/,
  );
  await assert.rejects(fs.stat(path.join(root, 'dist')), { code: 'ENOENT' });
});
