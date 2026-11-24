import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { tryAcquireProcessLock } from '@agent-device/host-kit/file';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import { AppError } from '@agent-device/kernel/errors';
import {
  changePlugin,
  listPlugins,
  createPluginSelectionGuard,
  storePluginCandidates,
} from './store.ts';
import { pluginHome, selectPlugin, pluginSource } from '@agent-device/test-kit';

vi.mock('@agent-device/host-kit/command', () => ({ runCmd: vi.fn() }));
afterEach(() => vi.mocked(runCmd).mockReset());

const packageName = '@example/provider';
function readPluginConfig(env: NodeJS.ProcessEnv) {
  const file = path.join(env.AGENT_DEVICE_HOME!, 'config.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

function installedPlugins(env: NodeJS.ProcessEnv) {
  const home = env.AGENT_DEVICE_HOME!;
  return Object.entries(readPluginConfig(env).plugins ?? {}).map(([name, selection]) => {
    const { installation, options } = selection as { installation: string; options?: unknown };
    return {
      name,
      selection: { installation, options },
      directory: path.join(home, 'plugins', installation, 'node_modules', name),
    };
  });
}

/** Stands in for `npm install`: writes a v2 plugin package into the staged project. */
function installFixture(name = packageName, provider = 'example', version = '1.2.3') {
  vi.mocked(runCmd).mockImplementation(async (command, argv, options) => {
    assert.equal(command, 'npm');
    assert.equal(argv[argv.indexOf('--prefix') + 1], options!.cwd);
    assert.ok(argv.includes('--global=false'));
    assert.ok(argv.includes('--ignore-scripts'));
    assert.ok(argv.includes('--workspaces=false'));
    assert.ok(argv.includes('--package-lock=true'));
    const directory = path.join(options!.cwd!, 'node_modules', name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({
        name,
        version,
        type: 'module',
        engines: { node: '>=22.12' },
        'agent-device': { apiVersion: 3, provider },
        exports: { './agent-device': { import: './plugin.mjs' } },
      }),
    );
    fs.writeFileSync(path.join(directory, 'plugin.mjs'), pluginSource(provider));
    return { stdout: '', stderr: '', exitCode: 0 };
  });
}

test('add, pinned update and remove preserve flags, options and old installations', async () => {
  const { home, env } = pluginHome();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ platform: 'android' }));
  installFixture();
  await changePlugin('add', `${packageName}@1.2.3`, env);
  const [first] = installedPlugins(env);
  const config = readPluginConfig(env);
  config.plugins![packageName]!.options = { region: 'eu' };
  config.plugins![packageName]!.installation = '../damaged';
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  await changePlugin('update', packageName, env);
  const [second] = installedPlugins(env);
  assert.notEqual(first!.directory, second!.directory);
  assert.deepEqual(second!.selection.options, { region: 'eu' });
  const project = path.resolve(second!.directory, '../../..');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).dependencies,
    { [packageName]: '1.2.3' },
  );
  assert.equal(readPluginConfig(env).platform, 'android');
  await changePlugin('remove', packageName, env);
  assert.deepEqual(installedPlugins(env), []);
  assert.ok(fs.existsSync(first!.directory));
  assert.ok(fs.existsSync(second!.directory));
});

test.each([
  ['@agent-device/limrun', '0.22.1'],
  ['@agent-device/maestro', '0.22.0-nightly-0-22.20261118.187'],
  ['@agent-device/replay', '0.22.0-nightly.20261118.186'],
  ['@agent-device/web', '0.22.1'],
])('bare add stages %s at the running core version %s', async (name, version) => {
  const { env } = pluginHome();
  installFixture(name, 'example', version);
  await changePlugin('add', name, env, version);
  const [installed] = installedPlugins(env);
  const project = path.resolve(installed!.directory, '../../..');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).dependencies,
    { [name]: version },
  );
  assert.equal(readPluginConfig(env).plugins[name].version, undefined);
});

test('matching installs follow a CLI upgrade while explicit versions remain pinned', async () => {
  const { env } = pluginHome();
  const name = '@agent-device/limrun';
  installFixture(name, 'limrun', '0.22.1');
  await changePlugin('add', name, env, '0.22.1');
  installFixture(name, 'limrun', '0.22.2');
  await changePlugin('update', name, env, '0.22.2');
  assert.equal((await listPlugins(env, []))[0]?.version, '0.22.2');

  installFixture(name, 'limrun', '0.22.1');
  await changePlugin('add', `${name}@0.22.1`, env, '0.22.2');
  await changePlugin('update', name, env, '0.22.2');
  assert.equal((await listPlugins(env, []))[0]?.version, '0.22.1');
});

test.each(['0.22.0-dev', '0.0.0'])(
  'bare first-party add refuses core version %s before npm',
  async (version) => {
    const { env } = pluginHome();
    await assert.rejects(
      changePlugin('add', '@agent-device/limrun', env, version),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.reason, 'plugin_version_unresolved');
        return true;
      },
    );
    assert.equal(vi.mocked(runCmd).mock.calls.length, 0);
  },
);

test('a registry target failure names the required plugin version and preserves selection', async () => {
  const { env } = pluginHome();
  const name = '@agent-device/limrun';
  installFixture(name, 'limrun', '0.22.1');
  await changePlugin('add', name, env, '0.22.1');
  const before = readPluginConfig(env);
  vi.mocked(runCmd).mockRejectedValue(
    new AppError('COMMAND_FAILED', 'npm install failed', {
      stdout: '{"error":{"code":"ETARGET"}}',
    }),
  );
  await assert.rejects(changePlugin('update', name, env, '0.22.2'), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.reason, 'plugin_version_resolution_failed');
    assert.equal(error.details?.package, name);
    assert.equal(error.details?.version, '0.22.2');
    return true;
  });
  assert.deepEqual(readPluginConfig(env), before);
});

test('failed npm install and incompatible replacement preserve the active selection', async () => {
  const { home, env } = pluginHome();
  installFixture();
  await changePlugin('add', packageName, env);
  const before = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  vi.mocked(runCmd).mockRejectedValue(new Error('npm failed'));
  await assert.rejects(changePlugin('update', packageName, env), /npm failed/);
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), before);
  // The replacement exports neither ./agent-device nor a root entry, so it is not a plugin package.
  vi.mocked(runCmd).mockImplementation(async (_command, _argv, options) => {
    const directory = path.join(options!.cwd!, 'node_modules', packageName);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({
        name: packageName,
        version: '2.0.0',
        type: 'module',
        exports: { './tools': './tools.js' },
      }),
    );
    fs.writeFileSync(path.join(directory, 'tools.js'), 'export {};');
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  await assert.rejects(changePlugin('update', packageName, env), { code: 'INVALID_ARGS' });
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), before);
  assert.equal(fs.readdirSync(path.join(home, 'plugins')).length, 1);
});

test('a factory shaped for the removed v1 contract still installs but never loads', async () => {
  const { env } = pluginHome();
  vi.mocked(runCmd).mockImplementation(async (_command, _argv, options) => {
    const directory = path.join(options!.cwd!, 'node_modules', packageName);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({
        name: packageName,
        version: '1.2.3',
        type: 'module',
        engines: { node: '>=22.12' },
        'agent-device': { apiVersion: 3, provider: 'example' },
        exports: { './agent-device': { import: './plugin.mjs' } },
      }),
    );
    fs.writeFileSync(path.join(directory, 'plugin.mjs'), 'export default () => ({ register: 1 });');
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  // Installation only needs a loadable default export; the registry rejects the shape later.
  await changePlugin('add', packageName, env);
  const [listed] = await listPlugins(env, []);
  assert.deepEqual(
    { name: listed?.name, compatible: listed?.compatible, reason: listed?.error?.reason },
    { name: packageName, compatible: false, reason: 'incompatible-plugin-api' },
  );
});

test('concurrent additions serialize without dropping the other package', async () => {
  const { env } = pluginHome();
  vi.mocked(runCmd).mockImplementation(async (_, __, options) => {
    const { dependencies } = JSON.parse(
      fs.readFileSync(path.join(options!.cwd!, 'package.json'), 'utf8'),
    );
    const name: string = Object.keys(dependencies)[0]!;
    const directory = path.join(options!.cwd!, 'node_modules', name);
    fs.mkdirSync(directory, { recursive: true });
    const provider = name.toLowerCase().replaceAll(/[^a-z0-9-]/g, '-');
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({
        name,
        version: '1.2.3',
        type: 'module',
        engines: { node: '>=22.12' },
        'agent-device': { apiVersion: 3, provider },
        exports: { './agent-device': { import: './plugin.mjs' } },
      }),
    );
    fs.writeFileSync(path.join(directory, 'plugin.mjs'), pluginSource(provider));
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  await Promise.all([changePlugin('add', 'constructor', env), changePlugin('add', 'two', env)]);
  assert.deepEqual(
    installedPlugins(env)
      .map(({ name }) => name)
      .sort(),
    ['constructor', 'two'],
  );
});

test('invalid package sources and damaged selections fail before invoking npm', async () => {
  const { home, env } = pluginHome();
  for (const name of [
    '--registry=evil',
    '../plugin',
    'plugin@file:../plugin',
    'plugin@npm:other',
    'https://example.com/plugin',
  ]) {
    await assert.rejects(changePlugin('add', name, env), { code: 'INVALID_ARGS' });
  }
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ plugins: { one: { installation: '../other' } } }),
  );
  assert.equal((await listPlugins(env, []))[0]?.compatible, false);
  await changePlugin('remove', 'one', env);
  assert.deepEqual(await listPlugins(env, []), []);
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ plugins: { UPPERCASE: null } }),
  );
  await changePlugin('remove', 'UPPERCASE', env);
  assert.deepEqual(await listPlugins(env, []), []);
  assert.equal(vi.mocked(runCmd).mock.calls.length, 0);
});

test('a duplicate provider id is settled by the registry when the store composes', async () => {
  const { home, env } = pluginHome();
  selectPlugin(home, 'first', pluginSource('example'));
  selectPlugin(home, 'second', pluginSource('example'));
  const listed = await listPlugins(env, []);
  assert.deepEqual(
    listed.map(({ name, compatible, error }) => [name, compatible, error?.reason]),
    [
      ['first', true, undefined],
      ['second', false, 'duplicate_provider'],
    ],
  );
  // A dormant built-in claims the id first, so a store package cannot take it either.
  const { home: otherHome, env: otherEnv } = pluginHome();
  selectPlugin(otherHome, 'limrun-plugin', pluginSource('limrun'));
  const limrun = await listPlugins(otherEnv, ['limrun']);
  assert.deepEqual(
    limrun.map(({ name, compatible, error }) => [name, compatible, error?.reason]),
    [['limrun-plugin', false, 'duplicate_provider']],
  );
});

test('broken siblings do not block pinned updates or unrelated additions', async () => {
  for (const damage of ['missing', 'json', 'load']) {
    const { home, env } = pluginHome();
    installFixture();
    await changePlugin('add', `${packageName}@1.2.3`, env);
    selectPlugin(home, 'broken', 'throw new Error("must not evaluate");');
    const config = readPluginConfig(env);
    config.plugins![packageName]!.options = { region: 'eu' };
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
    const directory = path.join(home, 'plugins', config.plugins!.broken!.installation);
    if (damage === 'missing') fs.rmSync(directory, { recursive: true });
    if (damage === 'json')
      fs.writeFileSync(path.join(directory, 'node_modules/broken/package.json'), '{');
    await changePlugin('update', packageName, env);
    const repaired = readPluginConfig(env).plugins![packageName]!;
    assert.deepEqual(repaired.options, { region: 'eu' });
    assert.equal(repaired.version, '1.2.3');
    assert.deepEqual(readPluginConfig(env).plugins!.broken, config.plugins!.broken);
    installFixture('other', 'other');
    await changePlugin('add', 'other', env);
    const listed = await listPlugins(env, []);
    assert.deepEqual(
      listed.map(({ name, compatible }) => [name, compatible]),
      [
        ['@example/provider', true],
        ['broken', false],
        ['other', true],
      ],
    );
  }
});

test('a fixed daemon detects replacement of a selected replay installation without importing it', async () => {
  const { home, env } = pluginHome();
  const name = '@agent-device/replay';
  selectPlugin(home, name, 'throw new Error("selection checks must not import this package");');
  const guard = createPluginSelectionGuard(await storePluginCandidates(env), env);
  assert.doesNotThrow(() => guard(name));
  selectPlugin(home, '@example/unrelated', 'throw new Error("unrelated");');
  assert.doesNotThrow(() => guard(name));
  selectPlugin(home, name, 'throw new Error("replacement, same npm version");');
  assert.throws(
    () => guard(name),
    (error: unknown) => {
      assert.equal(
        (error as { details?: { reason?: string } }).details?.reason,
        'daemon-plugin-set-stale',
      );
      return true;
    },
  );
});

test('a null replay selection is invalid configuration rather than an absent package', () => {
  const { home, env } = pluginHome();
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ plugins: { '@agent-device/replay': null } }),
  );
  const guard = createPluginSelectionGuard([], env);
  assert.throws(
    () => guard('@agent-device/replay'),
    (error: unknown) => {
      assert.equal((error as { details?: { reason?: string } }).details?.reason, 'invalid_plugin');
      return true;
    },
  );
});

test('equivalent nested option key order keeps the daemon selection current', async () => {
  const { home, env } = pluginHome();
  const name = '@agent-device/replay';
  selectPlugin(home, name, 'throw new Error("must not import");');
  const config = readPluginConfig(env);
  const selection = config.plugins[name];
  selection.options = { region: 'eu', nested: { retries: 2, labels: ['a', 'b'] } };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  const guard = createPluginSelectionGuard(await storePluginCandidates(env), env);
  config.plugins[name] = {
    options: { nested: { labels: ['a', 'b'], retries: 2 }, region: 'eu' },
    installation: selection.installation,
  };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config, null, 2));
  assert.doesNotThrow(() => guard(name));
  config.plugins[name].options.nested.labels.reverse();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  assert.throws(
    () => guard(name),
    (error: unknown) => {
      assert.equal(
        (error as { details?: { reason?: string } }).details?.reason,
        'daemon-plugin-set-stale',
      );
      return true;
    },
  );
});

test.each([
  ['1.2.3-01', false],
  ['1.2.3-rc.01', false],
  ['1.2.3-00', false],
  ['1.2.3-0', true],
  ['1.2.3-01a', true],
  ['1.2.3-1a.0+001', true],
  ['1.2.3+01', true],
] as const)('artifact selection validates exact SemVer %s', async (version, valid) => {
  const { home, env } = pluginHome();
  selectPlugin(home, 'example', pluginSource('example'), { manifest: { version } });
  const config = readPluginConfig(env);
  config.plugins.example.artifact = {
    version,
    integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
  };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  const [entry] = await listPlugins(env, []);
  assert.equal(entry?.compatible, valid);
  if (valid) assert.equal(entry?.version, version);
  assert.equal(vi.mocked(runCmd).mock.calls.length, 0);
});

test('registry staging cleanup failure reports both errors and releases the store lock', async () => {
  const { home, env } = pluginHome();
  const plugins = path.join(fs.realpathSync(home), 'plugins');
  const installError = new AppError('INVALID_ARGS', 'registry install failed');
  const cleanupError = new Error('registry cleanup failed');
  vi.mocked(runCmd).mockRejectedValue(installError);
  const rm = fs.rmSync.bind(fs);
  const spy = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
    if (typeof target === 'string' && path.dirname(target) === plugins) throw cleanupError;
    return rm(target, options);
  });
  let failure: unknown;
  try {
    await changePlugin('add', packageName, env);
  } catch (error) {
    failure = error;
  } finally {
    spy.mockRestore();
  }
  const attempt = tryAcquireProcessLock({
    lockDirPath: path.join(fs.realpathSync(home), 'plugins.lock'),
    owner: { ...readCurrentOwnerIdentity(), acquiredAtMs: Date.now() },
  });
  if (attempt.status === 'acquired') await attempt.acquisition.release();
  assert.equal(attempt.status, 'acquired');
  assert.ok(failure instanceof AppError);
  assert.equal(failure.code, 'COMMAND_FAILED');
  assert.ok(failure.details);
  assert.equal(failure.details.reason, 'plugin_cleanup_failed');
  assert.equal(
    (failure.details.installationError as { message: string }).message,
    installError.message,
  );
  assert.equal((failure.details.cleanupError as { message: string }).message, cleanupError.message);
  assert.equal(failure.cause, installError);
});

test('removal does not create or remove a staging project', async () => {
  const { home, env } = pluginHome();
  selectPlugin(home, 'example', pluginSource('example'));
  const before = fs.readdirSync(path.join(home, 'plugins'));
  const spy = vi.spyOn(fs, 'rmSync');
  try {
    await changePlugin('remove', 'example', env);
    assert.deepEqual(fs.readdirSync(path.join(home, 'plugins')), before);
    assert.equal(
      spy.mock.calls.filter(
        ([target]) =>
          typeof target === 'string' &&
          path.dirname(target) === path.join(fs.realpathSync(home), 'plugins'),
      ).length,
      0,
    );
    assert.deepEqual(readPluginConfig(env).plugins, {});
  } finally {
    spy.mockRestore();
  }
});

test('a release failure after publication preserves the selected installation', async () => {
  const { home, env } = pluginHome();
  installFixture();
  const lock = path.join(fs.realpathSync(home), 'plugins.lock');
  const rmdir = fs.rmdirSync.bind(fs);
  const spy = vi.spyOn(fs, 'rmdirSync').mockImplementation((target, options) => {
    if (target === lock) throw new Error('release failed');
    return rmdir(target, options);
  });
  try {
    await assert.rejects(
      changePlugin('add', packageName, env),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'COMMAND_FAILED' &&
        error.details?.ownerReleaseUnverified === true,
    );
    const [selected] = installedPlugins(env);
    assert.ok(selected);
    assert.ok(fs.existsSync(path.join(selected.directory, 'package.json')));
  } finally {
    spy.mockRestore();
  }
});
