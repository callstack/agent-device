import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { pluginHome, selectV2Plugin, v2RegistrationSource } from '@agent-device/test-kit';
import { readVersion } from '@agent-device/host-kit/version';
import { runCliCapture } from '../../__tests__/cli-capture.ts';
import { usageForCommand } from '../parser/args.ts';

vi.mock('@agent-device/host-kit/version', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agent-device/host-kit/version')>();
  return { ...original, readVersion: vi.fn(original.readVersion) };
});

afterEach(() => {
  // Restores the real reader this checkout's version reports, so no case hands its channel to
  // the next one.
  vi.mocked(readVersion).mockReset();
});

// The release `scripts/release-version.mjs` stamps on the 0.22 source branch. Its provider plugins
// publish at the same version, and their `latest` tag stays the staged placeholder.
const NIGHTLY_0_22 = '0.22.0-nightly-0-22.20261118.187';

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

test('connect browserstack without its plugin names the package, even with credentials set', async () => {
  vi.mocked(readVersion).mockReturnValue('0.22.0-dev');
  const { home, env } = pluginHome();
  const result = await runCliCapture(
    ['connect', 'browserstack', '--platform', 'android', '--session', 'checkout', '--json'],
    {
      cwd: home,
      env: { ...env, BROWSERSTACK_USERNAME: 'user', BROWSERSTACK_ACCESS_KEY: 'key' },
      stateDirPrefix: 'connect-missing-browserstack-',
    },
  );
  assert.equal(result.code, 1);
  assert.deepEqual(result.calls, []);
  const { error } = JSON.parse(result.stdout);
  assert.equal(error.code, 'UNSUPPORTED_OPERATION');
  assert.deepEqual(error.details, {
    reason: 'plugin-not-installed',
    provider: 'browserstack',
    package: '@agent-device/browserstack',
    installCommand: 'agent-device plugins add @agent-device/browserstack@nightly-0.22',
  });
  assert.match(error.hint, /agent-device plugins add @agent-device\/browserstack/);
});

test('connect prints installation guidance without JSON', async () => {
  const { home, env } = pluginHome();
  const result = await runCliCapture(['connect', 'testmu', '--session', 'ci'], {
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
  const result = await runCliCapture(['connect', 'testmuu', '--session', 'ci', '--json'], {
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
  const result = await runCliCapture(['connect', 'testmu', '--session', 'ci', '--json'], {
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
  const result = await runCliCapture(['connect', 'testmu', '--session', 'ci', '--json'], {
    cwd: home,
    env,
    stateDirPrefix: 'connect-plugin-no-connection-',
  });
  assert.equal(result.code, 1);
  assert.deepEqual(result.calls, []);
  assert.equal(JSON.parse(result.stdout).error.details.reason, 'plugin-unavailable');
});

// A channel plugin's `latest` tag is the staged placeholder, so an unversioned selector installs a
// package that exports no factory and the plugin manager refuses it as `incompatible_plugin`. The
// guidance has to name the release built with the running core.
test('a 0.22 nightly core prescribes the matching channel plugin release', async () => {
  vi.mocked(readVersion).mockReturnValue(NIGHTLY_0_22);
  const { home, env } = pluginHome();
  const result = await runCliCapture(
    ['connect', 'browserstack', '--platform', 'android', '--session', 'checkout', '--json'],
    { cwd: home, env, stateDirPrefix: 'connect-nightly-browserstack-' },
  );
  assert.equal(result.code, 1);
  assert.deepEqual(result.calls, []);
  const { error } = JSON.parse(result.stdout);
  assert.deepEqual(error.details, {
    reason: 'plugin-not-installed',
    provider: 'browserstack',
    package: '@agent-device/browserstack',
    installCommand: `agent-device plugins add @agent-device/browserstack@${NIGHTLY_0_22}`,
  });
  assert.match(error.hint, new RegExp(`plugins add @agent-device/browserstack@${NIGHTLY_0_22}`));
  assert.match(error.hint, /If a local daemon is already running/);
  const help = await usageForCommand('remote');
  assert.ok(help?.includes(`${error.details.installCommand}\n`));
});

test('a stable core prescribes the plain package for the same plugin', async () => {
  vi.mocked(readVersion).mockReturnValue('0.22.0');
  const { home, env } = pluginHome();
  const result = await runCliCapture(
    ['connect', 'browserstack', '--platform', 'android', '--session', 'checkout', '--json'],
    { cwd: home, env, stateDirPrefix: 'connect-stable-browserstack-' },
  );
  assert.equal(result.code, 1);
  const { error } = JSON.parse(result.stdout);
  assert.equal(error.details.installCommand, 'agent-device plugins add @agent-device/browserstack');
  const help = await usageForCommand('remote');
  assert.ok(help?.includes(`${error.details.installCommand}\n`));
});

test('a 0.22 nightly core still prescribes the plain package for a full-channel plugin', async () => {
  vi.mocked(readVersion).mockReturnValue(NIGHTLY_0_22);
  const { home, env } = pluginHome();
  const result = await runCliCapture(
    ['connect', 'testmu', '--platform', 'android', '--session', 'checkout', '--json'],
    { cwd: home, env, stateDirPrefix: 'connect-nightly-testmu-' },
  );
  assert.equal(result.code, 1);
  assert.deepEqual(result.calls, []);
  const { error } = JSON.parse(result.stdout);
  assert.equal(error.details.installCommand, 'agent-device plugins add @agent-device/testmu');
});

test('connect reports an unreadable plugin selection instead of prescribing a new installation', async () => {
  const { home, env } = pluginHome();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ plugins: [] }));
  const result = await runCliCapture(['connect', 'testmu', '--session', 'ci', '--json'], {
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
