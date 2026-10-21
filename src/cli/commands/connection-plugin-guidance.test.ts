import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { pluginHome, selectV2Plugin, v2RegistrationSource } from '@agent-device/test-kit';
import { runCliCapture } from '../../__tests__/cli-capture.ts';

test('connect names a missing provider plugin and returns installation guidance before dispatch', async () => {
  const { home, env } = pluginHome();
  const result = await runCliCapture(
    ['connect', 'testmu', '--platform', 'android', '--session', 'checkout', '--json'],
    { cwd: home, env, stateDirPrefix: 'connect-missing-plugin-' },
  );
  assert.equal(result.code, 1);
  assert.deepEqual(result.calls, []);
  const { error } = JSON.parse(result.stdout);
  assert.equal(error.code, 'UNSUPPORTED_OPERATION');
  assert.deepEqual(error.details, {
    reason: 'plugin-not-installed',
    provider: 'testmu',
    package: '@agent-device/testmu',
    installCommand: 'agent-device plugins add @agent-device/testmu',
  });
  assert.match(error.hint, /agent-device plugins add @agent-device\/testmu/);
  assert.match(error.hint, /retry your original command/);
  assert.match(error.hint, /If a local daemon is already running/);
});

test('connect prints installation guidance without JSON', async () => {
  const { home, env } = pluginHome();
  const result = await runCliCapture(['connect', 'testmu'], {
    cwd: home,
    env,
    stateDirPrefix: 'connect-plugin-text-',
  });
  assert.equal(result.code, 1);
  assert.deepEqual(result.calls, []);
  assert.match(result.stderr, /TestMu AI requires the @agent-device\/testmu plugin/);
  assert.match(result.stderr, /agent-device plugins add @agent-device\/testmu/);
});

test('connect keeps an unknown provider separate from a known missing plugin', async () => {
  const { home, env } = pluginHome();
  const result = await runCliCapture(['connect', 'testmuu', '--json'], {
    cwd: home,
    env,
    stateDirPrefix: 'connect-unknown-provider-',
  });
  assert.equal(result.code, 1);
  assert.deepEqual(result.calls, []);
  const { error } = JSON.parse(result.stdout);
  assert.equal(error.code, 'INVALID_ARGS');
  assert.match(error.message, /Unknown connect provider: testmuu/);
  assert.equal(error.details?.reason, undefined);
  assert.doesNotMatch(error.hint, /plugins add/);
});

test('connect reports a failed selected plugin even when its error text describes a missing plugin', async () => {
  const { home, env } = pluginHome();
  selectV2Plugin(
    home,
    '@agent-device/testmu',
    'throw new Error("TestMu AI requires the @agent-device/testmu plugin.");',
  );
  const result = await runCliCapture(['connect', 'testmu', '--json'], {
    cwd: home,
    env,
    stateDirPrefix: 'connect-broken-plugin-',
  });
  assert.equal(result.code, 1);
  assert.deepEqual(result.calls, []);
  const { error } = JSON.parse(result.stdout);
  assert.equal(error.details.reason, 'plugin-unavailable');
  assert.equal(error.details.failedPlugins[0].package, '@agent-device/testmu');
  assert.equal(error.details.installCommand, undefined);
  assert.match(error.hint, /plugins list --json/);
  assert.doesNotMatch(error.hint, /plugins add/);
});

test('connect does not call a selected plugin missing when it has no connection callbacks', async () => {
  const { home, env } = pluginHome();
  selectV2Plugin(home, '@agent-device/testmu', v2RegistrationSource('testmu'));
  const result = await runCliCapture(['connect', 'testmu', '--json'], {
    cwd: home,
    env,
    stateDirPrefix: 'connect-plugin-no-connection-',
  });
  assert.equal(result.code, 1);
  assert.deepEqual(result.calls, []);
  assert.equal(JSON.parse(result.stdout).error.details.reason, 'plugin-unavailable');
});

test('connect reports an unreadable plugin selection instead of prescribing a new installation', async () => {
  const { home, env } = pluginHome();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ plugins: [] }));
  const result = await runCliCapture(['connect', 'testmu', '--json'], {
    cwd: home,
    env,
    stateDirPrefix: 'connect-plugin-config-',
  });
  assert.equal(result.code, 1);
  assert.deepEqual(result.calls, []);
  const { error } = JSON.parse(result.stdout);
  assert.equal(error.details.reason, 'plugin-unavailable');
  assert.match(error.details.failedPlugins[0].error.message, /Plugin config/);
  assert.equal(error.details.installCommand, undefined);
});
