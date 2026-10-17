import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { pluginConnectionNames, primePluginConnections } from '@agent-device/plugins/connection';
import {
  connectionProviderCapabilities,
  connectProviderNamesForError,
  isConnectProviderName,
  primeProviderConnection,
} from './provider-policy.ts';
import {
  pluginHome,
  selectPlugin,
  selectV2Plugin,
  v2RegistrationSource,
} from '@agent-device/test-kit';

test('provider policy projects provider identity into semantic capabilities', () => {
  assert.deepEqual(connectionProviderCapabilities('limrun'), {
    leaseKind: 'direct-device-provider',
    requiresAppAttachment: false,
    requiresRemoteDaemon: false,
    supportsArtifacts: false,
    supportsDeferredAppSelection: true,
    supportsDirectPortReverse: true,
    usesCloudWebDriverLease: false,
  });
  const browserStack = connectionProviderCapabilities('browserstack');
  assert.equal(browserStack.supportsArtifacts, true);
  assert.equal(browserStack.usesCloudWebDriverLease, true);
  assert.equal(connectionProviderCapabilities('aws-device-farm').requiresAppAttachment, true);
  assert.equal(connectionProviderCapabilities('proxy').leaseKind, 'proxy');
});

test('plugin capabilities come from the same environment as the provider name check', () => {
  const { home, env } = pluginHome();
  selectPlugin(home, 'example', 'example', 'export default () => {};');
  const { installation } = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))
    .plugins.example;
  const manifestPath = path.join(
    home,
    'plugins',
    installation,
    'node_modules/example/package.json',
  );
  const declared = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const connection = {
    leaseKind: 'direct-device-provider',
    requiresAppAttachment: true,
    requiresRemoteDaemon: false,
    supportsArtifacts: true,
    supportsDeferredAppSelection: false,
    supportsDirectPortReverse: false,
    usesCloudWebDriverLease: true,
  } as const;
  declared.agentDevicePlugin.connection = connection;
  fs.writeFileSync(manifestPath, JSON.stringify(declared));

  assert.equal(isConnectProviderName('example', env), true);
  assert.deepEqual(connectionProviderCapabilities('example', env), connection);
});

test('a v2 plugin declares its capabilities in code, so they are read once the store is primed', async () => {
  const { home, env } = pluginHome();
  const connection = {
    leaseKind: 'direct-device-provider',
    requiresAppAttachment: false,
    requiresRemoteDaemon: false,
    supportsArtifacts: true,
    supportsDeferredAppSelection: false,
    supportsDirectPortReverse: false,
    usesCloudWebDriverLease: true,
  } as const;
  selectV2Plugin(
    home,
    'example-v2',
    v2RegistrationSource('example-v2', {
      extra: `connection: { capabilities: ${JSON.stringify(connection)}, resolve() {}, verify() {} },`,
    }),
  );

  assert.equal(isConnectProviderName('example-v2', env), false);
  await primeProviderConnection('example-v2', env);
  assert.equal(isConnectProviderName('example-v2', env), true);
  assert.deepEqual(connectionProviderCapabilities('example-v2', env), connection);
});

test('a store plugin that fails to load is named where an unknown connect provider is refused', async () => {
  const { home, env } = pluginHome();
  selectV2Plugin(home, 'broken-v2', 'throw new Error("import failed");');
  await primeProviderConnection('broken-v2', env);
  expect(connectProviderNamesForError(env)).toMatch(
    /Plugins that failed to load: broken-v2: import failed/,
  );
});

test('once the store is primed a duplicate v1 manifest no longer supplies capabilities', async () => {
  const { home, env } = pluginHome();
  selectPlugin(home, 'dup', 'browserstack', 'export default () => {};');
  const { installation } = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))
    .plugins.dup;
  const manifestPath = path.join(home, 'plugins', installation, 'node_modules/dup/package.json');
  const declared = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  declared.agentDevicePlugin.connection = {
    leaseKind: 'direct-device-provider',
    requiresAppAttachment: true,
    requiresRemoteDaemon: false,
    supportsArtifacts: true,
    supportsDeferredAppSelection: false,
    supportsDirectPortReverse: false,
    usesCloudWebDriverLease: true,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(declared));

  expect(pluginConnectionNames(env)).toEqual(['browserstack']);
  await primePluginConnections(env, ['browserstack']);
  expect(pluginConnectionNames(env)).toEqual([]);
});
