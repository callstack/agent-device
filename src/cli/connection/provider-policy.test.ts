import { providerPluginConnectionCapabilities } from '@agent-device/contracts/provider-plugin-catalog';
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
  providerRouteForConnection,
} from './provider-policy.ts';
import { pluginHome, selectPlugin, pluginSource } from '@agent-device/test-kit';
import limrun from '@agent-device/limrun';
import awsDeviceFarm from '@agent-device/aws-device-farm';
import browserstack from '@agent-device/browserstack';
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
  // Limrun's lease policy is its own on every route: the catalog answers it before any plugin store is
  // loaded, so a host without the plugin still defers app selection and bounds the lease.
  assert.equal(connectionProviderCapabilities('limrun', {}).leaseKind, 'direct-device-provider');
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
    acceptsHostedAttachment: true,
  });
  // BrowserStack and AWS Device Farm declare no catalog capabilities: without an installed plugin
  // nothing declares theirs, and they keep the daemon's own routing.
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

test('the plugin catalog copies the connection capabilities each plugin declares', () => {
  // The catalog answers a connection's lease policy on a route that loads no plugin, so every copy it
  // carries must equal what the plugin itself declares.
  for (const [provider, plugin] of [
    ['limrun', limrun()],
    ['aws-device-farm', awsDeviceFarm()],
    ['browserstack', browserstack()],
  ] as const) {
    const declared = providerPluginConnectionCapabilities(provider);
    if (declared === undefined) continue;
    assert.deepEqual(declared, declaredConnectionCapabilities(plugin), provider);
  }
  // Limrun is the row a remote connection is answered from without the plugin, so its copy is required.
  assert.deepEqual(
    providerPluginConnectionCapabilities('limrun'),
    declaredConnectionCapabilities(limrun()),
  );
});

test('a route is answered by the daemon only when a base URL is actually set', () => {
  // The daemon client reads the same two settings with `??` and treats an empty one as no daemon, so an
  // empty flag or an empty environment setting drives the connection from this host — the one route
  // that refuses a provider it has no plugin for.
  assert.equal(
    providerRouteForConnection({ daemonBaseUrl: undefined, env: {} }),
    'drives-connection',
  );
  assert.equal(
    providerRouteForConnection({
      daemonBaseUrl: undefined,
      env: { AGENT_DEVICE_DAEMON_BASE_URL: '' },
    }),
    'drives-connection',
  );
  assert.equal(
    providerRouteForConnection({
      daemonBaseUrl: '',
      env: { AGENT_DEVICE_DAEMON_BASE_URL: 'http://127.0.0.1:50000' },
    }),
    'drives-connection',
  );
  assert.equal(
    providerRouteForConnection({
      daemonBaseUrl: undefined,
      env: { AGENT_DEVICE_DAEMON_BASE_URL: 'http://127.0.0.1:50000' },
    }),
    'dispatches-to-remote-daemon',
  );
  assert.equal(
    providerRouteForConnection({
      daemonBaseUrl: 'http://127.0.0.1:50000',
      env: {},
    }),
    'dispatches-to-remote-daemon',
  );
});
