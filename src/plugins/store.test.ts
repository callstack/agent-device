import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { changePlugin, installedPlugins, listPlugins } from './store.ts';
import { pluginHome, writePlugin, selectPlugin } from './plugin.fixtures.ts';

vi.mock('@agent-device/host-kit/command', () => ({ runCmd: vi.fn() }));
afterEach(() => vi.mocked(runCmd).mockReset());

const packageName = '@example/provider';
function readPluginConfig(env: NodeJS.ProcessEnv) {
  return JSON.parse(fs.readFileSync(path.join(env.AGENT_DEVICE_HOME!, 'config.json'), 'utf8'));
}

function installFixture(name = packageName, apiVersion = 1, provider = 'example') {
  vi.mocked(runCmd).mockImplementation(async (command, argv, options) => {
    assert.equal(command, 'npm');
    assert.equal(argv[argv.indexOf('--prefix') + 1], options!.cwd);
    assert.ok(argv.includes('--global=false'));
    assert.ok(argv.includes('--ignore-scripts'));
    assert.ok(argv.includes('--workspaces=false'));
    assert.ok(argv.includes('--package-lock=true'));
    writePlugin(options!.cwd!, name, apiVersion, provider);
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
  installFixture(packageName, 2);
  await assert.rejects(changePlugin('update', packageName, env), { code: 'INVALID_ARGS' });
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), before);
  assert.equal(fs.readdirSync(path.join(home, 'plugins')).length, 1);
});

test('concurrent additions serialize without dropping the other package', async () => {
  const { env } = pluginHome();
  vi.mocked(runCmd).mockImplementation(async (_, __, options) => {
    const { dependencies } = JSON.parse(
      fs.readFileSync(path.join(options!.cwd!, 'package.json'), 'utf8'),
    );
    const name = Object.keys(dependencies)[0]!;
    writePlugin(options!.cwd!, name, 1, name);
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
  assert.throws(() => installedPlugins(env), { code: 'INVALID_ARGS' });
  assert.equal(listPlugins(env)[0]?.compatible, false);
  await changePlugin('remove', 'one', env);
  assert.deepEqual(listPlugins(env), []);
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ plugins: { UPPERCASE: null } }),
  );
  await changePlugin('remove', 'UPPERCASE', env);
  assert.deepEqual(listPlugins(env), []);
  assert.equal(vi.mocked(runCmd).mock.calls.length, 0);
});

test('provider collisions refuse activation and preserve existing selections', async () => {
  const { env } = pluginHome();
  installFixture();
  await assert.rejects(changePlugin('add', packageName, env, ['example']), {
    code: 'INVALID_ARGS',
  });
  assert.deepEqual(installedPlugins(env), []);
  await changePlugin('add', packageName, env);
  installFixture('other');
  await assert.rejects(changePlugin('add', 'other', env), { code: 'INVALID_ARGS' });
  assert.equal(installedPlugins(env).length, 1);
});

test('broken siblings do not block pinned updates or unrelated additions', async () => {
  for (const damage of ['missing', 'json', 'abi']) {
    const { home, env } = pluginHome();
    installFixture();
    await changePlugin('add', `${packageName}@1.2.3`, env);
    selectPlugin(home, 'broken', 'broken', 'throw new Error("must not evaluate");', 2);
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
    installFixture('other', 1, 'other');
    await changePlugin('add', 'other', env);
    assert.throws(() => installedPlugins(env), { code: 'INVALID_ARGS' });
  }
});
