import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test, vi } from 'vitest';
import * as command from '@agent-device/host-kit/command';
import { tryAcquireProcessLock } from '@agent-device/host-kit/file';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import { AppError } from '@agent-device/kernel/errors';
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
  factoryGate?: string,
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
  let pluginSource = v2RegistrationSource(name).replace(
    'export default (options = {}) => (',
    `export default (options = {}) => (fs.writeFileSync(${JSON.stringify(sentinel)}, 'factory'), `,
  );
  if (factoryGate) {
    pluginSource = pluginSource.replace('export default ', 'const createPlugin = ');
    pluginSource += `\nexport default async (options) => {
      const gate = globalThis[Symbol.for(${JSON.stringify(factoryGate)})];
      gate.enter();
      await gate.resume;
      return createPlugin(options);
    };`;
  }
  fs.writeFileSync(path.join(source, 'plugin.mjs'), pluginSource);
  const packed = command.runCmdSync(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', root],
    { cwd: source },
  );
  assert.equal(packed.exitCode, 0, packed.stderr);
  return { archive: path.join(root, JSON.parse(packed.stdout)[0].filename), sentinel };
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

test('artifact installation rejects replacement bytes consumed by npm', async () => {
  const root = mkdtempForTestSync('plugin-artifact-replaced-');
  const originalRoot = path.join(root, 'original');
  const replacementRoot = path.join(root, 'replacement');
  const original = packFixture(originalRoot, 'fixture-replaced');
  const replacement = packFixture(replacementRoot, 'fixture-replaced');
  assert.notDeepEqual(fs.readFileSync(original.archive), fs.readFileSync(replacement.archive));
  const { home, env: isolated } = pluginHome();
  const env = { ...process.env, ...isolated };
  const runCmd = command.runCmd;
  let replaced = false;
  const spy = vi.spyOn(command, 'runCmd').mockImplementation(async (program, args, options) => {
    if (program === 'npm' && args[0] === 'install' && args.at(-2) === '--') {
      fs.copyFileSync(replacement.archive, args.at(-1)!);
      replaced = true;
    }
    return runCmd(program, args, options);
  });
  try {
    await assert.rejects(addPluginArtifact(original.archive, { cwd: root, env }), {
      code: 'INVALID_ARGS',
      details: { reason: 'artifact_integrity_mismatch' },
    });
    assert.equal(replaced, true);
    assert.equal(fs.existsSync(path.join(home, 'config.json')), false);
    assert.deepEqual(fs.readdirSync(path.join(home, 'plugins')), []);
    assert.equal(fs.existsSync(replacement.sentinel), false);
  } finally {
    spy.mockRestore();
  }
});

test('inventory retains one selection snapshot while a factory awaits', async () => {
  const root = mkdtempForTestSync('plugin-artifact-inventory-');
  const key = `agent-device.artifact-inventory.${crypto.randomUUID()}`;
  const first = packFixture(path.join(root, 'first'), 'fixture-inventory', undefined, key);
  const second = packFixture(path.join(root, 'second'), 'fixture-inventory');
  const { env: isolated } = pluginHome();
  const env = { ...process.env, ...isolated };
  const original = await addPluginArtifact(first.archive, { cwd: root, env });
  let enter!: () => void;
  let continueListing!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    continueListing = resolve;
  });
  const gates = globalThis as typeof globalThis & Record<symbol, unknown>;
  gates[Symbol.for(key)] = { enter, resume };
  const listing = listPlugins(env, []);
  try {
    await entered;
    await changePlugin('remove', original.name, env);
    const replacement = await addPluginArtifact(second.archive, { cwd: root, env });
    assert.notEqual(replacement.integrity, original.integrity);
    continueListing();
    const [entry] = await listing;
    assert.deepEqual(entry, {
      name: original.name,
      installation: original.installation,
      integrity: original.integrity,
      version: original.version,
      provider: 'fixture-inventory',
      compatible: true,
    });
    const [current] = await listPlugins(env, []);
    assert.equal(current?.installation, replacement.installation);
    assert.equal(current?.integrity, replacement.integrity);
  } finally {
    continueListing();
    await listing;
    delete gates[Symbol.for(key)];
  }
});

test.each([undefined, '~/plugin-store'])(
  'missing HOME does not preempt archive validation (%s)',
  async (override) => {
    const root = mkdtempForTestSync('plugin-artifact-home-');
    await assert.rejects(
      addPluginArtifact(path.join(root, 'missing.tgz'), {
        cwd: root,
        env: { HOME: undefined, AGENT_DEVICE_HOME: override },
      }),
      { code: 'ENOENT' },
    );
  },
);

test('failed staging cleanup reports both failures and releases the live store lock', async () => {
  const root = mkdtempForTestSync('plugin-artifact-cleanup-');
  const archive = path.join(root, 'broken.tgz');
  fs.writeFileSync(archive, 'invalid archive');
  const { home, env: isolated } = pluginHome();
  const env = { ...process.env, ...isolated };
  const plugins = path.join(fs.realpathSync(home), 'plugins');
  const installError = new AppError('INVALID_ARGS', 'installation failed');
  const cleanupError = new Error('staging cleanup failed');
  const run = vi.spyOn(command, 'runCmd').mockRejectedValue(installError);
  const rm = fs.rmSync.bind(fs);
  const cleanup = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
    if (typeof target === 'string' && path.dirname(target) === plugins) throw cleanupError;
    return rm(target, options);
  });
  let failure: unknown;
  try {
    try {
      await addPluginArtifact(archive, { cwd: root, env });
      assert.fail('installation should fail');
    } catch (error) {
      failure = error;
    }
  } finally {
    cleanup.mockRestore();
    run.mockRestore();
  }
  const attempt = tryAcquireProcessLock({
    lockDirPath: path.join(fs.realpathSync(home), 'plugins.lock'),
    owner: { ...readCurrentOwnerIdentity(), acquiredAtMs: Date.now() },
    description: 'plugin installation',
  });
  if (attempt.status === 'acquired') await attempt.acquisition.release();
  assert.equal(attempt.status, 'acquired', 'the still-live host must not retain the lock');
  assert.ok(failure instanceof AppError);
  assert.equal(failure.code, 'COMMAND_FAILED');
  assert.equal(failure.details?.reason, 'plugin_cleanup_failed');
  assert.deepEqual(
    (({ code, message }) => ({ code, message }))(
      failure.details?.installationError as { code: string; message: string },
    ),
    { code: 'INVALID_ARGS', message: installError.message },
  );
  assert.deepEqual(
    (({ code, message }) => ({ code, message }))(
      failure.details?.cleanupError as { code: string; message: string },
    ),
    { code: 'UNKNOWN', message: cleanupError.message },
  );
  assert.equal(failure.cause, installError);
});

test('successful staging cleanup preserves the original installation error', async () => {
  const root = mkdtempForTestSync('plugin-artifact-cleanup-success-');
  const archive = path.join(root, 'broken.tgz');
  fs.writeFileSync(archive, 'invalid archive');
  const { home, env: isolated } = pluginHome();
  const installError = new AppError('INVALID_ARGS', 'installation failed');
  const run = vi.spyOn(command, 'runCmd').mockRejectedValue(installError);
  try {
    await assert.rejects(
      addPluginArtifact(archive, { cwd: root, env: { ...process.env, ...isolated } }),
      (error: unknown) => error === installError,
    );
    assert.deepEqual(fs.readdirSync(path.join(home, 'plugins')), []);
  } finally {
    run.mockRestore();
  }
});

test('malformed configuration fails before artifact staging', async () => {
  const root = mkdtempForTestSync('plugin-artifact-invalid-config-');
  const archive = path.join(root, 'invalid.tgz');
  fs.writeFileSync(archive, 'not a valid archive');
  const { home, env } = pluginHome();
  fs.writeFileSync(path.join(home, 'config.json'), '{');
  const spy = vi.spyOn(command, 'runCmd');
  try {
    await assert.rejects(addPluginArtifact(archive, { cwd: root, env }), { code: 'INVALID_ARGS' });
    assert.equal(spy.mock.calls.length, 0);
    assert.equal(fs.existsSync(path.join(home, 'plugins')), false);
  } finally {
    spy.mockRestore();
  }
});
