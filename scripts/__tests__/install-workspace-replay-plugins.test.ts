import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { storePluginCandidates } from '@agent-device/plugins/store';
import { readPluginPackageClaims } from '@agent-device/plugins/validate';
import { installWorkspaceReplayPlugins } from '../install-workspace-replay-plugins.ts';

/** The staged directory for one package in the one installation this script staged into `home`. */
function installedPackageDirectory(home: string, packageId: string): string {
  const directory = path.join(home, 'plugins');
  const installation = fs
    .readdirSync(directory)
    .find((name) =>
      fs.existsSync(path.join(directory, name, 'node_modules', `@agent-device/${packageId}`)),
    );
  assert.ok(installation, `no staged installation holds @agent-device/${packageId}`);
  return path.join(directory, installation, 'node_modules', `@agent-device/${packageId}`);
}

/** The manifest of one package in the one installation this script staged into `home`. */
function installedManifest(home: string, packageId: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(installedPackageDirectory(home, packageId), 'package.json'), 'utf8'),
  ) as Record<string, unknown>;
}

afterEach(() => vi.restoreAllMocks());

test('failed second staging keeps the previous config and removes both new installations', () => {
  const home = mkdtempForTestSync('workspace-plugin-staging-');
  const config = '{"platform":"android","plugins":{"existing":{"installation":"kept"}}}';
  const file = path.join(home, 'config.json');
  fs.writeFileSync(file, config);
  const symlink = fs.symlinkSync;
  vi.spyOn(fs, 'symlinkSync').mockImplementation((target, destination, type) => {
    if (path.basename(String(target)) === 'replay') throw new Error('second staging failed');
    symlink(target, destination, type);
  });
  assert.throws(
    () => installWorkspaceReplayPlugins({ AGENT_DEVICE_HOME: home }, true),
    /second staging failed/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), config);
  assert.deepEqual(fs.readdirSync(path.join(home, 'plugins')), []);
});

test('a non-source workspace install keeps the manifest fields the store reads before import', async () => {
  const home = mkdtempForTestSync('workspace-plugin-nonsource-');
  const env = { AGENT_DEVICE_HOME: home };
  installWorkspaceReplayPlugins(env, false);

  // The written manifest is what the store validates before it imports anything: the typed claims of
  // the `agent-device` field, and the `engines.node` floor.
  const claims = Object.fromEntries(
    await Promise.all(
      (['maestro', 'replay'] as const).map(async (packageId) => [
        packageId,
        readPluginPackageClaims(installedManifest(home, packageId)['agent-device']),
      ]),
    ),
  );
  assert.deepEqual(claims, {
    maestro: [{ kind: 'replay-backend', id: 'maestro' }],
    replay: [{ kind: 'replay-execution', id: 'ad' }],
  });
  for (const packageId of ['maestro', 'replay'] as const) {
    const workspace = path.resolve(import.meta.dirname, `../../packages/${packageId}`);
    const source = JSON.parse(
      fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    const installed = installedManifest(home, packageId);
    assert.deepEqual(installed.engines, source.engines);
    assert.deepEqual(installed['agent-device'], source['agent-device']);
  }

  // Both candidates carry their claims into the registry, so the store-installed replay and Maestro
  // packages are the ones the device lanes resolve.
  const candidates = await storePluginCandidates(env);
  assert.deepEqual(
    candidates.map(({ package: name, declaredClaims }) => [name, declaredClaims]),
    [
      ['@agent-device/maestro', [{ kind: 'replay-backend', id: 'maestro' }]],
      ['@agent-device/replay', [{ kind: 'replay-execution', id: 'ad' }]],
    ],
  );
  const { listPlugins } = await import('@agent-device/plugins/store');
  const listed = await listPlugins(env, []);
  assert.deepEqual(
    listed.map(({ name, backend, compatible }) => [name, backend, compatible]),
    [
      ['@agent-device/maestro', 'maestro', true],
      ['@agent-device/replay', 'ad', true],
    ],
    JSON.stringify(listed),
  );
});

test('a lane that names a managed platform plugin stages it with its runtime assets', () => {
  // The Linux lanes drive the family through the installed plugin, so staging must copy what the
  // plugin reads at runtime — the AT-SPI helper — beside the manifest claims the store validates.
  const home = mkdtempForTestSync('workspace-plugin-platform-');
  installWorkspaceReplayPlugins({ AGENT_DEVICE_HOME: home }, false, ['linux']);

  const manifest = installedManifest(home, 'linux');
  assert.deepEqual(readPluginPackageClaims(manifest['agent-device']), [
    { kind: 'platform', id: 'linux' },
  ]);
  const workspace = path.resolve(import.meta.dirname, '../../packages/platform-linux');
  assert.deepEqual(
    manifest.engines,
    JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8')).engines,
  );

  const helper = path.join(installedPackageDirectory(home, 'linux'), 'linux', 'atspi-dump.py');
  assert.equal(
    fs.readFileSync(helper, 'utf8'),
    fs.readFileSync(path.join(workspace, 'linux', 'atspi-dump.py'), 'utf8'),
  );
});

test('failed publication keeps the previous config and removes staged installations', () => {
  const home = mkdtempForTestSync('workspace-plugin-publish-');
  const config = '{"platform":"android"}';
  const file = path.join(home, 'config.json');
  fs.writeFileSync(file, config);
  vi.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw new Error('publish failed');
  });
  assert.throws(
    () => installWorkspaceReplayPlugins({ AGENT_DEVICE_HOME: home }, true),
    /publish failed/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), config);
  assert.deepEqual(fs.readdirSync(path.join(home, 'plugins')), []);
});
