import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import {
  pluginConnectionNames,
  pluginLoadFailures,
  primePluginConnections,
} from '@agent-device/plugins/connection';
import {
  connectionProviderCapabilities,
  connectProviderNamesForError,
  isConnectProviderName,
  primeProviderConnection,
} from './provider-policy.ts';
import { pluginHome, selectV2Plugin, v2RegistrationSource } from '@agent-device/test-kit';

test('provider policy projects provider identity into semantic capabilities', () => {
  assert.deepEqual(connectionProviderCapabilities('limrun'), {
    leaseKind: 'direct-device-provider',
    requiresAppAttachment: false,
    requiresRemoteDaemon: false,
    supportsArtifacts: false,
    supportsDeferredAppSelection: true,
    supportsDirectPortReverse: true,
    usesCloudWebDriverLease: false,
    holdsCloudDevice: true,
    forgetsEndedConnectionLease: true,
  });
  const browserStack = connectionProviderCapabilities('browserstack');
  assert.equal(browserStack.supportsArtifacts, true);
  assert.equal(browserStack.usesCloudWebDriverLease, true);
  assert.equal(connectionProviderCapabilities('aws-device-farm').requiresAppAttachment, true);
  assert.equal(connectionProviderCapabilities('proxy').leaseKind, 'proxy');
});

test('a manifest connection on a store package supplies no capabilities', async () => {
  const { home, env } = pluginHome();
  selectV2Plugin(home, 'example', v2RegistrationSource('example'), {
    manifest: {
      agentDevicePlugin: {
        apiVersion: 1,
        provider: 'example',
        entry: './plugin.mjs',
        connection: {
          leaseKind: 'direct-device-provider',
          requiresAppAttachment: true,
          requiresRemoteDaemon: false,
          supportsArtifacts: true,
          supportsDeferredAppSelection: false,
          supportsDirectPortReverse: false,
          usesCloudWebDriverLease: true,
        },
      },
    },
  });

  assert.equal(isConnectProviderName('example', env), false);
  await primeProviderConnection('example', env);
  // The factory declares no connection, so the manifest never fills the gap.
  assert.equal(isConnectProviderName('example', env), false);
  assert.deepEqual(pluginConnectionNames(env), []);
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

test('a plugin that fails to load supplies no connection name even after priming', async () => {
  const { home, env } = pluginHome();
  selectV2Plugin(home, 'dup', v2RegistrationSource('browserstack'));
  await primePluginConnections(env, ['browserstack']);
  // The built-in claimed the id first, so the store package registers nothing.
  expect(pluginConnectionNames(env)).toEqual([]);
  expect(pluginLoadFailures(env).map(({ package: name, error }) => [name, error.reason])).toEqual([
    ['dup', 'duplicate_provider'],
  ]);
});
