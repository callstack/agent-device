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
import { pluginHome, selectPlugin, pluginSource } from '@agent-device/test-kit';
import limrun from '@agent-device/limrun';
import { declaredConnectionCapabilities } from '../../__tests__/test-utils/plugin-declaration.fixtures.ts';

test('provider policy projects provider identity into semantic capabilities', async () => {
  const limrunStore = pluginHome();
  selectPlugin(
    limrunStore.home,
    '@agent-device/limrun',
    pluginSource('limrun', {
      extra: `connection: { capabilities: ${JSON.stringify(declaredConnectionCapabilities(limrun()))}, resolve() {}, verify() {} },`,
    }),
  );
  // Without the plugin nothing declares Limrun's capabilities; the installed one answers once primed.
  assert.equal(connectionProviderCapabilities('limrun', {}).leaseKind, 'remote-provider');
  await primeProviderConnection('limrun', limrunStore.env);
  assert.deepEqual(connectionProviderCapabilities('limrun', limrunStore.env), {
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
  // BrowserStack is a plugin: without an installed one nothing declares its capabilities.
  assert.equal(
    connectionProviderCapabilities('browserstack', pluginHome().env).leaseKind,
    'remote-provider',
  );
  assert.equal(connectionProviderCapabilities('aws-device-farm', {}).leaseKind, 'remote-provider');
  assert.equal(connectionProviderCapabilities('proxy', {}).leaseKind, 'proxy');
});

test('an installed AWS Device Farm plugin declares its capabilities once the store is primed', async () => {
  const { home, env } = pluginHome();
  selectPlugin(
    home,
    '@agent-device/aws-device-farm',
    pluginSource('aws-device-farm', {
      extra: `connection: { capabilities: { leaseKind: 'direct-device-provider', requiresAppAttachment: true, requiresRemoteDaemon: false, supportsArtifacts: true, supportsDeferredAppSelection: false, supportsDirectPortReverse: false, usesCloudWebDriverLease: true }, resolve() {}, verify() {} },`,
    }),
  );

  assert.equal(connectionProviderCapabilities('aws-device-farm', env).requiresAppAttachment, false);
  await primeProviderConnection('aws-device-farm', env);
  assert.equal(connectionProviderCapabilities('aws-device-farm', env).requiresAppAttachment, true);
});

test('a manifest connection on a store package supplies no capabilities', async () => {
  const { home, env } = pluginHome();
  selectPlugin(home, 'example', pluginSource('example'), {
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
  selectPlugin(
    home,
    'example-v2',
    pluginSource('example-v2', {
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
  selectPlugin(home, 'broken-v2', 'throw new Error("import failed");');
  await primeProviderConnection('broken-v2', env);
  expect(connectProviderNamesForError(env)).toMatch(
    /Plugins that failed to load: broken-v2: import failed/,
  );
});

test('a plugin that fails to load supplies no connection name even after priming', async () => {
  const { home, env } = pluginHome();
  selectPlugin(home, 'dup', pluginSource('aws-device-farm'));
  await primePluginConnections(env, ['aws-device-farm']);
  // The built-in claimed the id first, so the store package registers nothing.
  expect(pluginConnectionNames(env)).toEqual([]);
  expect(pluginLoadFailures(env).map(({ package: name, error }) => [name, error.reason])).toEqual([
    ['dup', 'duplicate_provider'],
  ]);
});
