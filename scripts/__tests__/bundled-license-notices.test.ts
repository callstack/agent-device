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
  // The populated notice ends like any other text file: exactly one trailing newline, so a reader
  // who cats it and a tool that counts its lines both see a finished last license block.
  assert.ok(notices.endsWith('\n'), 'notices end with a newline');
  assert.ok(!notices.endsWith('\n\n'), 'notices carry exactly one trailing newline');
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

// A licensed package without a version once shipped a notice reading `included@null (MIT)`,
// attributing code to a release that never existed. The version is checked first, so the failure
// names the version-less package rather than its license.
test.each([
  { name: 'no version field', version: undefined },
  { name: 'blank version', version: '   ' },
])('bundling rejects a licensed dependency with a missing version: $name', async ({ version }) => {
  const manifest: Record<string, unknown> = { name: 'included', license: 'MIT', main: 'index.js' };
  if (version !== undefined) manifest.version = version;
  const root = await fixture({
    'input.ts': "export { value } from 'included';",
    'node_modules/included/package.json': JSON.stringify(manifest),
    'node_modules/included/index.js': 'export const value = 42;',
    'node_modules/included/LICENSE': 'Copyright fixture author\nFull license terms.',
  });
  await assert.rejects(bundle(root), /Bundled dependency included is missing its version/);
  await assert.rejects(fs.stat(path.join(root, 'dist/THIRD_PARTY_NOTICES.txt')), {
    code: 'ENOENT',
  });
});

// The build enumerates the bundled modules itself. A package whose `package.json` names neither a
// version nor a license, or a module with no `package.json` at all, is still bundled code: beside a
// licensed neighbor it must stop the build, not drop out of a notices file that names the neighbor.
test.each<{ name: string; files: Record<string, string>; failure: RegExp }>([
  {
    name: 'package with neither license nor version',
    files: {
      'node_modules/omitted/package.json': JSON.stringify({ name: 'omitted', main: 'index.js' }),
      'node_modules/omitted/index.js': 'export const value = process.env.OMITTED;',
    },
    failure: /Bundled dependency omitted is missing its version/,
  },
  {
    name: 'module with no package.json',
    files: { 'node_modules/omitted/index.js': 'export const value = process.env.OMITTED;' },
    failure:
      /Bundled module node_modules\/omitted\/index\.js has no package\.json naming its package/,
  },
])(
  'bundling rejects an unattributable module beside a licensed one: $name',
  async (fixtureCase) => {
    const root = await fixture({
      'input.ts': [
        "export { value } from 'included';",
        "export { value as omitted } from 'omitted';",
      ].join('\n'),
      'node_modules/included/package.json': JSON.stringify({
        name: 'included',
        version: '1.0.0',
        license: 'MIT',
        main: 'index.js',
      }),
      'node_modules/included/index.js': 'export const value = process.env.INCLUDED;',
      'node_modules/included/LICENSE': 'Copyright fixture author\nFull license terms.',
      ...fixtureCase.files,
    });
    await assert.rejects(bundle(root), fixtureCase.failure);
    await assert.rejects(fs.stat(path.join(root, 'dist/THIRD_PARTY_NOTICES.txt')), {
      code: 'ENOENT',
    });
  },
);

// The attribution block is one line per package, so manifest text that spans lines must not split it.
test('multiline license and author metadata render as one attribution line', async () => {
  const root = await fixture({
    'input.ts': "export { value } from 'included';",
    'node_modules/included/package.json': JSON.stringify({
      name: 'included',
      version: '1.0.0',
      license: 'MIT\nOR Apache-2.0',
      author: 'Multi\nline author <author@example.test>',
      main: 'index.js',
    }),
    'node_modules/included/index.js': 'export const value = process.env.INCLUDED;',
    'node_modules/included/LICENSE': 'Copyright fixture author\nFull license terms.',
  });
  await bundle(root);
  const notices = await fs.readFile(path.join(root, 'dist/THIRD_PARTY_NOTICES.txt'), 'utf8');
  assert.equal(
    notices.split('\n\n')[0],
    'included@1.0.0 (MIT OR Apache-2.0): [1]; Author: Multi line author <author@example.test>',
  );
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
    const [sourceNotices, apacheLicense] = await Promise.all([
      fs.readFile(new URL('../../LICENSES/jpeg-js.txt', import.meta.url), 'utf8'),
      fs.readFile(new URL('../../LICENSES/Apache-2.0.txt', import.meta.url), 'utf8'),
    ]);
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
      'LICENSES/jpeg-js.txt': sourceNotices,
      'LICENSES/Apache-2.0.txt': apacheLicense,
    });
    if (version === '0.4.5') {
      await assert.rejects(bundle(root), /LICENSES\/jpeg-js\.txt.*jpeg-js@0\.4\.5/);
      return;
    }
    await bundle(root);
    const notices = await fs.readFile(path.join(root, 'dist/THIRD_PARTY_NOTICES.txt'), 'utf8');
    assert.match(notices, /Package-level BSD terms/);
    assert.match(notices, /Copyright 2011 notmasteryet/);
    assert.match(notices, /Adobe Systems Incorporated/);
    assert.match(notices, /JPEG encoder ported to JavaScript and optimized by Andreas Ritter/);
    assert.ok(notices.includes(sourceNotices.replaceAll('\r\n', '\n').trim()));
    assert.ok(notices.includes(apacheLicense.replaceAll('\r\n', '\n').trim()));
  },
);

// A project that genuinely bundles nothing keeps getting the generic notice: the content policy that
// holds the published CLI to naming somebody is the publish gate's, not this formatter's. Pinning it
// here keeps a future "reject the placeholder" edit at the formatter from breaking an empty build.
test('a bundle with no third-party code emits the generic notice unchanged', async () => {
  const root = await fixture({
    'input.ts': "import { external } from 'external';\nexport const result = external;",
    'node_modules/external/package.json': JSON.stringify({
      name: 'external',
      version: '1.0.0',
      main: 'index.js',
    }),
    'node_modules/external/index.js': 'export const external = 1;',
  });
  await bundle(root);
  assert.equal(
    await fs.readFile(path.join(root, 'dist/THIRD_PARTY_NOTICES.txt'), 'utf8'),
    'No third-party dependencies are bundled.\n',
  );
});

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

test.each([
  { version: '0.2.0', newline: '\n', lineEnding: 'LF' },
  { version: '0.2.0', newline: '\r\n', lineEnding: 'CRLF' },
  { version: '0.2.1', newline: '\n', lineEnding: 'LF' },
])(
  'bundled xdelta WASM $version requires matching complete notices with $lineEnding line endings',
  async ({ version, newline }) => {
    const [sourceNotices, apacheLicense] = await Promise.all([
      fs.readFile(new URL('../../LICENSES/xdelta3-wasm.txt', import.meta.url), 'utf8'),
      fs.readFile(new URL('../../LICENSES/Apache-2.0.txt', import.meta.url), 'utf8'),
    ]);
    const root = await fixture({
      'input.ts': "export { value } from '@limrun/xdelta3-wasm';",
      'node_modules/@limrun/xdelta3-wasm/package.json': JSON.stringify({
        name: '@limrun/xdelta3-wasm',
        version,
        license: 'Apache-2.0',
        main: 'index.js',
      }),
      'node_modules/@limrun/xdelta3-wasm/index.js':
        'export const value = process.env.FIXTURE_NUMBER;',
      'LICENSES/xdelta3-wasm.txt': sourceNotices.replaceAll('\r\n', '\n').replaceAll('\n', newline),
      'LICENSES/Apache-2.0.txt': apacheLicense.replaceAll('\r\n', '\n').replaceAll('\n', newline),
    });
    if (version !== '0.2.0') {
      await assert.rejects(bundle(root), /Refresh LICENSES/);
      return;
    }
    await bundle(root);
    const notices = await fs.readFile(path.join(root, 'dist/THIRD_PARTY_NOTICES.txt'), 'utf8');
    assert.ok(notices.includes(sourceNotices.replaceAll('\r\n', '\n').trim()));
    assert.ok(notices.includes(apacheLicense.replaceAll('\r\n', '\n').trim()));
  },
);
