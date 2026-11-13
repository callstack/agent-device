import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import {
  changePlugin,
  listPlugins,
  createPluginSelectionGuard,
  storePluginCandidates,
} from './store.ts';
import { pluginHome, selectV2Plugin, v2RegistrationSource } from '@agent-device/test-kit';

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
function installFixture(name = packageName, provider = 'example') {
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
        version: '1.2.3',
        type: 'module',
        exports: { './agent-device': { import: './plugin.mjs' } },
      }),
    );
    fs.writeFileSync(path.join(directory, 'plugin.mjs'), v2RegistrationSource(provider));
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

test('a factory shaped for the removed v1 contract still installs', async () => {
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
    { name: listed?.name, compatible: listed?.compatible },
    { name: packageName, compatible: false },
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
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({
        name,
        version: '1.2.3',
        type: 'module',
        exports: { './agent-device': { import: './plugin.mjs' } },
      }),
    );
    fs.writeFileSync(
      path.join(directory, 'plugin.mjs'),
      v2RegistrationSource(name.toLowerCase().replaceAll(/[^a-z0-9-]/g, '-')),
    );
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
  selectV2Plugin(home, 'first', v2RegistrationSource('example'));
  selectV2Plugin(home, 'second', v2RegistrationSource('example'));
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
  selectV2Plugin(otherHome, 'limrun-plugin', v2RegistrationSource('limrun'));
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
    selectV2Plugin(home, 'broken', 'throw new Error("must not evaluate");');
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
  selectV2Plugin(home, name, 'throw new Error("selection checks must not import this package");');
  const guard = createPluginSelectionGuard(await storePluginCandidates(env), env);
  assert.doesNotThrow(() => guard(name));
  selectV2Plugin(home, '@example/unrelated', 'throw new Error("unrelated");');
  assert.doesNotThrow(() => guard(name));
  selectV2Plugin(home, name, 'throw new Error("replacement, same npm version");');
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
