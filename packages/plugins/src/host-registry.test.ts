import { describe, expect, test } from 'vitest';
import type { ProviderAndroidHost, ProviderHostCapabilities, ProviderPluginHost } from './host.ts';
import { createPluginHost } from './host.ts';

const ANDROID: ProviderAndroidHost = {
  runAdb: async () => ({ exitCode: 0, stdout: 'android', stderr: '' }),
  adbError: async () => {
    throw new Error('not needed for host assertion');
  },
  withAdbProvider: async (_provider, _serial, task) => await task(),
  runShell: async () => ({ exitCode: 0, stdout: 'android', stderr: '' }),
  createPortReverse: async () => ({
    ensure: async () => {},
    remove: async () => {},
    removeAllOwned: async () => {},
  }),
  listApps: async () => [],
  readLogs: async () => '',
  keyboardState: async () => ({ visible: false, inputOwner: 'unknown' }),
  dismissKeyboard: async () => ({
    visible: false,
    inputOwner: 'unknown',
    attempts: 0,
    wasVisible: false,
    dismissed: false,
  }),
};

const CAPABILITIES: ProviderHostCapabilities = {
  android: ANDROID,
  apple: { applicationTools: { marker: 'apple' } as never },
};

describe('createPluginHost facets', () => {
  test('a host without capabilities carries neither facet', () => {
    const host = createPluginHost({ env: {}, cwd: '/' }, undefined);
    expect('android' in host).toBe(false);
    expect('apple' in host).toBe(false);
  });

  test('a host carries exactly the facets its capabilities supply', () => {
    const androidOnly = createPluginHost({ env: {}, cwd: '/' }, undefined, { android: ANDROID });
    expect(androidOnly.android).toBe(ANDROID);
    expect('apple' in androidOnly).toBe(false);

    const both = createPluginHost({ env: {}, cwd: '/' }, undefined, CAPABILITIES);
    expect(both.android).toBe(ANDROID);
    expect(both.apple?.applicationTools).toEqual({ marker: 'apple' });
  });
});

describe('registry hosts', () => {
  test('setup receives the policy capabilities once and connection hosts never carry them', async () => {
    const { resolveProviderPlugins, startProviderRegistry } = await import('./registry.ts');
    let capabilityCalls = 0;
    const setupHosts: ProviderPluginHost[] = [];
    const connectionHosts: ProviderPluginHost[] = [];
    const plugin = () => ({
      apiVersion: 2,
      provider: 'example',
      credentials: { variables: [] },
      setup: async (host: ProviderPluginHost) => {
        setupHosts.push(host);
        return { webDriver: { provider: 'example' } };
      },
      connection: {
        capabilities: {
          leaseKind: 'direct-device-provider',
          requiresAppAttachment: false,
          requiresRemoteDaemon: false,
          supportsArtifacts: true,
          supportsDeferredAppSelection: false,
          supportsDirectPortReverse: false,
          usesCloudWebDriverLease: true,
        },
        resolve: async ({ host }: { host: ProviderPluginHost }) => {
          connectionHosts.push(host);
          return { profile: { leaseProvider: 'example', platform: 'ios' } };
        },
        verify: async ({ host }: { host: ProviderPluginHost }) => {
          connectionHosts.push(host);
          return { provider: 'example', service: 'example', verificationMessage: 'ok' };
        },
      },
    });
    const resolved = await resolveProviderPlugins([
      { source: 'embedder', load: plugin },
      { source: 'embedder', provider: 'second', load: () => ({ ...plugin(), provider: 'second' }) },
    ]);
    const registry = await startProviderRegistry(
      resolved,
      { env: {}, cwd: '/' },
      {
        adaptWebDriver: async () => {
          throw new Error('not needed for host assertion');
        },
        hostCapabilities: () => {
          capabilityCalls += 1;
          return CAPABILITIES;
        },
      },
    );
    expect(capabilityCalls).toBe(1);
    expect(setupHosts).toHaveLength(2);
    for (const host of setupHosts) {
      expect(host.android).toBe(ANDROID);
      expect(host.apple).toBe(CAPABILITIES.apple);
    }

    const connection = resolved.connections.get('example')!;
    const flags = { json: false, help: false, version: false };
    await connection.resolve({ flags, stateDir: '/', cwd: '/', env: {} });
    await connection.verify({ flags, cwd: '/', env: {} });
    expect(connectionHosts).toHaveLength(2);
    for (const host of connectionHosts) {
      expect('android' in host).toBe(false);
      expect('apple' in host).toBe(false);
    }
    await registry.close();
  });

  test('a policy without hostCapabilities sets plugins up without facets', async () => {
    const { resolveProviderPlugins, startProviderRegistry } = await import('./registry.ts');
    let observed: ProviderPluginHost | undefined;
    const resolved = await resolveProviderPlugins([
      {
        source: 'embedder',
        load: () => ({
          apiVersion: 2,
          provider: 'example',
          credentials: { variables: [] },
          setup: async (host: ProviderPluginHost) => {
            observed = host;
            return { webDriver: { provider: 'example' } };
          },
        }),
      },
    ]);
    const registry = await startProviderRegistry(
      resolved,
      { env: {}, cwd: '/' },
      {
        adaptWebDriver: async () => {
          throw new Error('not needed for host assertion');
        },
      },
    );
    expect('android' in observed!).toBe(false);
    expect('apple' in observed!).toBe(false);
    await registry.close();
  });
});
