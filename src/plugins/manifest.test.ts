import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { readPluginManifest } from './manifest.ts';
import { pluginHome, writePlugin } from './plugin.fixtures.ts';

test('manifest compatibility is checked without evaluating plugin code', () => {
  const { home } = pluginHome();
  const directory = writePlugin(home);
  assert.equal(readPluginManifest(directory).agentDevicePlugin.provider, 'example');
  writePlugin(home, '@example/provider', 2);
  assert.throws(() => readPluginManifest(directory), {
    code: 'INVALID_ARGS',
    details: {
      reason: 'incompatible_plugin',
      apiVersion: 1,
      hint: 'Install a plugin release supporting agentDevicePlugin.apiVersion 1.',
    },
  });
});

test('manifest refuses traversal and symlink entries outside the installed package', () => {
  const { home } = pluginHome();
  const directory = writePlugin(home);
  const outside = path.join(home, 'outside.js');
  fs.writeFileSync(outside, 'throw new Error("outside");');
  fs.unlinkSync(path.join(directory, 'plugin.js'));
  fs.symlinkSync(outside, path.join(directory, 'plugin.js'));
  assert.throws(() => readPluginManifest(directory), { code: 'INVALID_ARGS' });
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  manifest.agentDevicePlugin.entry = '../../../outside.js';
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest));
  assert.throws(() => readPluginManifest(directory), { code: 'INVALID_ARGS' });
});

test('connection metadata admits local providers and rejects malformed or remote policies', () => {
  const { home } = pluginHome();
  const directory = writePlugin(home);
  const file = path.join(directory, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const connection = {
    leaseKind: 'direct-device-provider',
    requiresAppAttachment: true,
    requiresRemoteDaemon: false,
    supportsArtifacts: true,
    supportsDeferredAppSelection: false,
    supportsDirectPortReverse: false,
    usesCloudWebDriverLease: true,
  };
  const read = (policy: unknown) => {
    manifest.agentDevicePlugin.connection = policy;
    fs.writeFileSync(file, JSON.stringify(manifest));
    return readPluginManifest(directory);
  };
  assert.deepEqual(read(connection).agentDevicePlugin.connection, connection);
  for (const invalid of [
    null,
    {},
    { ...connection, leaseKind: 'remote-daemon' },
    { ...connection, requiresRemoteDaemon: true },
    { ...connection, supportsArtifacts: 'true' },
    { ...connection, supportsDeferredAppSelection: undefined },
  ]) {
    assert.throws(() => read(invalid), { code: 'INVALID_ARGS' });
  }
});
