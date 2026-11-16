import { expect, test } from 'vitest';
import { withCommandExecutorOverride } from '@agent-device/host-kit/command';
import { createPluginHost } from './host.ts';

test('plugin host runs commands with the AWS command bounds', async () => {
  await withCommandExecutorOverride(
    async (command, args, options) => {
      expect(command).toBe('aws');
      expect(args).toEqual(['devicefarm', 'get-project']);
      expect(options.maxBuffer).toBe(10 * 1024 * 1024);
      expect(options.timeoutMs).toBe(30_000);
      return { stdout: '{"project":{}}', stderr: '', exitCode: 0 };
    },
    async () => {
      await expect(
        createPluginHost({ env: {}, cwd: '/' }, undefined).runHostCommand('aws', [
          'devicefarm',
          'get-project',
        ]),
      ).resolves.toEqual({ stdout: '{"project":{}}' });
    },
  );
});

test('commands use the supplied host and overlay request environment without ambient values', async () => {
  const { mkdtempForTestSync } = await import('@agent-device/test-kit');
  const { realpathSync } = await import('node:fs');
  const { withCommandHost } = await import('@agent-device/host-kit/command');
  const cwd = realpathSync(mkdtempForTestSync('plugin-command-host-'));
  const host = { cwd, env: { PLUGIN_VALUE: 'host', HOST_ONLY: 'present' } };
  const pluginHost = createPluginHost(host, undefined);
  const args = [
    '-e',
    'process.stdout.write(JSON.stringify({cwd:process.cwd(), value:process.env.PLUGIN_VALUE, hostOnly:process.env.HOST_ONLY, ambient:process.env.PLUGIN_AMBIENT}))',
  ];
  const previous = process.env.PLUGIN_AMBIENT;
  process.env.PLUGIN_AMBIENT = 'ambient';
  try {
    const plain = await pluginHost.runHostCommand(process.execPath, args);
    expect(JSON.parse(plain.stdout)).toEqual({ cwd, value: 'host', hostOnly: 'present' });
    const scoped = await withCommandHost({ host, requestEnv: { PLUGIN_VALUE: 'request' } }, () =>
      pluginHost.runHostCommand(process.execPath, args),
    );
    expect(JSON.parse(scoped.stdout)).toEqual({ cwd, value: 'request', hostOnly: 'present' });
  } finally {
    if (previous === undefined) delete process.env.PLUGIN_AMBIENT;
    else process.env.PLUGIN_AMBIENT = previous;
  }
});

test('connection resolve and verify use each call host independently', async () => {
  const { mkdtempForTestSync } = await import('@agent-device/test-kit');
  const { realpathSync } = await import('node:fs');
  const { resolveProviderPlugins } = await import('./registry.ts');
  const dirs = [
    realpathSync(mkdtempForTestSync('plugin-resolve-')),
    realpathSync(mkdtempForTestSync('plugin-verify-')),
  ];
  const observed: unknown[] = [];
  const run = async (host: import('./host.ts').ProviderPluginHost) => {
    const result = await host.runHostCommand(process.execPath, [
      '-e',
      'process.stdout.write(JSON.stringify([process.cwd(), process.env.CONNECTION_VALUE]))',
    ]);
    observed.push(JSON.parse(result.stdout));
  };
  const { connections } = await resolveProviderPlugins([
    {
      source: 'embedder',
      load: () => ({
        apiVersion: 2,
        provider: 'example',
        credentials: { variables: [] },
        setup: () => ({}),
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
          resolve: async ({ host }: { host: import('./host.ts').ProviderPluginHost }) => {
            await run(host);
            return { profile: { leaseProvider: 'example', platform: 'ios' } };
          },
          verify: async ({ host }: { host: import('./host.ts').ProviderPluginHost }) => {
            await run(host);
            return { provider: 'example', service: 'example', verificationMessage: 'ok' };
          },
        },
      }),
    },
  ]);
  const connection = connections.get('example')!;
  const flags = { json: false, help: false, version: false };
  await connection.resolve({
    flags,
    stateDir: dirs[0]!,
    cwd: dirs[0]!,
    env: { CONNECTION_VALUE: 'resolve' },
  });
  await connection.verify({ flags, cwd: dirs[1]!, env: { CONNECTION_VALUE: 'verify' } });
  expect(observed).toEqual([
    [dirs[0], 'resolve'],
    [dirs[1], 'verify'],
  ]);
});

test('provider registry setup receives its supplied command host', async () => {
  const { mkdtempForTestSync } = await import('@agent-device/test-kit');
  const { realpathSync } = await import('node:fs');
  const { resolveProviderPlugins, startProviderRegistry } = await import('./registry.ts');
  const cwd = realpathSync(mkdtempForTestSync('plugin-setup-host-'));
  let observed: unknown;
  const resolved = await resolveProviderPlugins([
    {
      source: 'embedder',
      load: () => ({
        apiVersion: 2,
        provider: 'example',
        credentials: { variables: [] },
        setup: async (host: import('./host.ts').ProviderPluginHost) => {
          const result = await host.runHostCommand(process.execPath, [
            '-e',
            'process.stdout.write(JSON.stringify([process.cwd(), process.env.SETUP_VALUE]))',
          ]);
          observed = JSON.parse(result.stdout);
          return { webDriver: { provider: 'example' } };
        },
      }),
    },
  ]);
  const registry = await startProviderRegistry(
    resolved,
    { cwd, env: { SETUP_VALUE: 'supplied' } },
    {
      adaptWebDriver: async () => {
        throw new Error('not needed for host assertion');
      },
    },
  );
  expect(observed).toEqual([cwd, 'supplied']);
  await registry.close();
});
