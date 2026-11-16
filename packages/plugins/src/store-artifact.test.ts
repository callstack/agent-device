import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'vitest';
import { mkdtempForTestSync, pluginHome, v2RegistrationSource } from '@agent-device/test-kit';
import {
  addPluginArtifact,
  changePlugin,
  createPluginSelectionGuard,
  listPlugins,
  storePluginCandidates,
} from './store.ts';

function packFixture(
  root: string,
  name: string,
  exportsField: unknown = { './agent-device': './plugin.mjs' },
) {
  const source = path.join(root, name);
  fs.mkdirSync(source, { recursive: true });
  const sentinel = path.join(root, `${name}-executed`);
  fs.writeFileSync(
    path.join(source, 'package.json'),
    JSON.stringify({
      name,
      version: '1.2.3',
      type: 'module',
      exports: exportsField,
      scripts: {
        preinstall: `node sentinel.cjs`,
        install: `node sentinel.cjs`,
        postinstall: `node sentinel.cjs`,
      },
    }),
  );
  fs.writeFileSync(
    path.join(source, 'sentinel.cjs'),
    `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'script')`,
  );
  fs.writeFileSync(
    path.join(source, 'plugin.mjs'),
    v2RegistrationSource(name).replace(
      'export default (options = {}) => (',
      `export default (options = {}) => (fs.writeFileSync(${JSON.stringify(sentinel)}, 'factory'), `,
    ),
  );
  const output = execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', root],
    { cwd: source, encoding: 'utf8' },
  );
  return { archive: path.join(root, JSON.parse(output)[0].filename), sentinel };
}

test('artifact installation preserves immutable identity, isolation, collision and stale guard', async () => {
  const root = mkdtempForTestSync('plugin-artifact-');
  const fixture = packFixture(root, 'fixture-provider');
  const { home, env: isolated } = pluginHome();
  const env = { ...process.env, ...isolated };
  const other = pluginHome();
  const expected = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(fixture.archive)).digest('base64')}`;
  const result = await addPluginArtifact(path.basename(fixture.archive), { cwd: root, env });
  assert.equal(result.integrity, expected);
  assert.equal(result.name, 'fixture-provider');
  assert.equal(result.version, '1.2.3');
  assert.equal(fs.existsSync(fixture.sentinel), false);
  assert.ok(fs.existsSync(fixture.archive));
  assert.deepEqual(await listPlugins(other.env, []), []);
  const guard = createPluginSelectionGuard(await storePluginCandidates(env), env);
  const configPath = path.join(home, 'config.json');
  const before = fs.readFileSync(configPath, 'utf8');
  await assert.rejects(addPluginArtifact(fixture.archive, { cwd: root, env }), {
    code: 'INVALID_ARGS',
  });
  await assert.rejects(changePlugin('update', result.name, env), { code: 'INVALID_ARGS' });
  await assert.rejects(changePlugin('add', result.name, env), { code: 'INVALID_ARGS' });
  assert.equal(fs.readFileSync(configPath, 'utf8'), before);
  assert.equal(fs.readdirSync(path.join(home, 'plugins')).length, 1);
  const [listed] = await listPlugins(env, []);
  assert.equal(listed?.version, '1.2.3');
  assert.equal(listed?.integrity, expected);
  assert.equal(listed?.installation, result.installation);
  assert.equal(fs.readFileSync(fixture.sentinel, 'utf8'), 'factory');
  const config = JSON.parse(before);
  config.plugins[result.name].artifact.integrity =
    `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
  fs.writeFileSync(configPath, JSON.stringify(config));
  assert.throws(
    () => guard(result.name),
    (error: unknown) =>
      (error as { details?: { reason?: string } }).details?.reason === 'daemon-plugin-set-stale',
  );
});

test('invalid artifact and missing export roll back without disturbing selections', async () => {
  const root = mkdtempForTestSync('plugin-artifact-invalid-');
  const { home, env: isolated } = pluginHome();
  const env = { ...process.env, ...isolated };
  const valid = packFixture(root, 'fixture-valid');
  await addPluginArtifact(valid.archive, { cwd: root, env });
  const before = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  const missing = packFixture(root, 'fixture-missing', { '.': './plugin.mjs' });
  await assert.rejects(addPluginArtifact(missing.archive, { cwd: root, env }));
  const bad = path.join(root, 'bad.tgz');
  fs.writeFileSync(bad, 'not an archive');
  await assert.rejects(addPluginArtifact(bad, { cwd: root, env }));
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), before);
  assert.equal(fs.readdirSync(path.join(home, 'plugins')).length, 1);
  assert.equal(fs.existsSync(missing.sentinel), false);
});

test('concurrent artifact additions preserve both selections', async () => {
  const root = mkdtempForTestSync('plugin-artifact-concurrent-');
  const one = packFixture(root, 'fixture-one');
  const two = packFixture(root, 'fixture-two');
  const { env: isolated } = pluginHome();
  const env = { ...process.env, ...isolated };
  await Promise.all(
    [one, two].map(({ archive }) => addPluginArtifact(archive, { cwd: root, env })),
  );
  assert.deepEqual(
    (await listPlugins(env, [])).map((plugin) => plugin.name),
    ['fixture-one', 'fixture-two'],
  );
  assert.equal(fs.existsSync(one.sentinel), true);
});

test('npm staging rejects an escaping symlink entry and leaves external files untouched', async () => {
  const { default: tar } = await import('tar-stream');
  const { gzipSync } = await import('node:zlib');
  const root = mkdtempForTestSync('plugin-artifact-symlink-');
  const outside = path.join(root, 'outside.mjs');
  fs.writeFileSync(outside, 'outside');
  const archive = path.join(root, 'malicious.tgz');
  const stream = tar.pack();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.entry(
    { name: 'package/package.json' },
    JSON.stringify({
      name: 'fixture-escape',
      version: '1.0.0',
      exports: { './agent-device': './plugin.mjs' },
    }),
  );
  stream.entry({ name: 'package/plugin.mjs', type: 'symlink', linkname: outside });
  stream.entry({ name: 'package/../../escape' }, 'escaped');
  const finished = new Promise<void>((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  stream.finalize();
  await finished;
  fs.writeFileSync(archive, gzipSync(Buffer.concat(chunks)));
  const { home, env: isolated } = pluginHome();
  await assert.rejects(
    addPluginArtifact(archive, { cwd: root, env: { ...process.env, ...isolated } }),
  );
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
  assert.equal(fs.existsSync(path.join(home, 'escape')), false);
  assert.equal(fs.existsSync(path.join(home, 'config.json')), false);
});
