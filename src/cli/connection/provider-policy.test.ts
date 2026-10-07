import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { connectionProviderCapabilities, isConnectProviderName } from './provider-policy.ts';
import { pluginHome, selectPlugin } from '../../plugins/plugin.fixtures.ts';
import { installedPlugins } from '../../plugins/store.ts';

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
  const manifestPath = path.join(installedPlugins(env)[0]!.directory, 'package.json');
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
