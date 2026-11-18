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

  test('a policy that fails to build its facets sets every plugin up without them', async () => {
    const { resolveProviderPlugins, startProviderRegistry } = await import('./registry.ts');
    const { countDiagnosticEventsByPhase, withDiagnosticsScope } =
      await import('@agent-device/host-kit/diagnostics');
    let attempts = 0;
    const setupHosts: ProviderPluginHost[] = [];
    const plugin = (provider: string) => ({
      apiVersion: 2 as const,
      provider,
      credentials: { variables: [] },
      setup: async (host: ProviderPluginHost) => {
        setupHosts.push(host);
        return { webDriver: { provider } };
      },
    });
    const resolved = await resolveProviderPlugins([
      { source: 'embedder', package: '@agent-device/first', load: () => plugin('first') },
      { source: 'embedder', package: '@agent-device/second', load: () => plugin('second') },
    ]);
    const registry = await withDiagnosticsScope({ debug: false }, async () => {
      const started = await startProviderRegistry(
        resolved,
        { env: {}, cwd: '/' },
        {
          adaptWebDriver: async (descriptor) => ({
            runtime: { provider: descriptor.provider } as never,
            platformModule: {} as never,
          }),
          hostCapabilities: async () => {
            attempts += 1;
            throw new Error('the platform wiring is unavailable');
          },
        },
      );
      return {
        started,
        diagnostics: countDiagnosticEventsByPhase(['plugin.host_capabilities_unavailable']),
      };
    });
    // The rejection belongs to the facet, not to a plugin: both set up, both register, both report
    // as active, and the build is attempted once rather than once per plugin.
    expect(attempts).toBe(1);
    expect(setupHosts).toHaveLength(2);
    for (const host of setupHosts) {
      expect('android' in host).toBe(false);
      expect('apple' in host).toBe(false);
    }
    expect(registry.started.registrations.map((registration) => registration.provider)).toEqual([
      'first',
      'second',
    ]);
    expect(registry.started.inventory.map((entry) => entry.state)).toEqual(['active', 'active']);
    expect(registry.diagnostics).toBe(1);
    await registry.started.close();
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
