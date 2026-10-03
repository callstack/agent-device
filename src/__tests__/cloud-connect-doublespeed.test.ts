import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { connectCommand } from '../cli/commands/connection.ts';
import type { AgentDeviceClient } from '../agent-device-client.ts';
import {
  readActiveConnectionState,
  type RemoteConnectionState,
} from '../remote/remote-connection-state.ts';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';
import { verifyDoublespeedConnection } from '@agent-device/doublespeed/connection-verification';
import doublespeedPlugin from '@agent-device/doublespeed';
import { createPluginHost } from '../plugins/host.ts';
import { selectPlugin, pluginHome } from '../plugins/plugin.fixtures.ts';
import { installedPlugins } from '../plugins/store.ts';
import manifest from '@agent-device/doublespeed/package.json' with { type: 'json' };
import type { PluginConnection } from '../plugins/connection.ts';

vi.mock('@agent-device/doublespeed/connection-verification', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/doublespeed/connection-verification')>()),
  verifyDoublespeedConnection: vi.fn(),
}));

vi.mock('../plugins/load.ts', () => ({
  withPluginConnection: async (
    _provider: string,
    env: NodeJS.ProcessEnv,
    runConnection: (connection: PluginConnection) => Promise<unknown>,
  ) => {
    const registration = await doublespeedPlugin(createPluginHost(env, undefined));
    try {
      return await runConnection(registration.connection);
    } finally {
      await registration.runtime.shutdown();
    }
  },
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
const mockedVerifyDoublespeedConnection = vi.mocked(verifyDoublespeedConnection);
beforeEach(() => {
  const { home, env } = pluginHome();
  selectPlugin(home, manifest.name, 'doublespeed', 'export default () => {};');
  const [plugin] = installedPlugins(env);
  const manifestPath = path.join(plugin!.directory, 'package.json');
  const declared = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  declared.agentDevicePlugin.connection = manifest.agentDevicePlugin.connection;
  fs.writeFileSync(manifestPath, JSON.stringify(declared));
  vi.stubEnv('AGENT_DEVICE_HOME', home);
  mockedVerifyDoublespeedConnection.mockResolvedValue({
    provider: 'doublespeed',
    service: 'Doublespeed',
    verificationMessage: 'Credentials and iOS simulator access verified.',
    device: {
      status: 'deferred',
      name: 'Provider-selected iOS simulator',
      platform: 'ios',
    },
    app: {
      status: 'missing',
      message: 'A new Doublespeed simulator does not have your app yet.',
    },
  });
});

test('connect doublespeed generates an iOS-only local daemon remote profile', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-doublespeed-');
  const stateDir = path.join(tempRoot, '.state');
  vi.stubEnv('DOUBLESPEED_API_KEY', 'dsx_test_key');

  try {
    await captureConnectStdout(async () => {
      await connectCommand({
        positionals: ['doublespeed'],
        flags: {
          json: true,
          help: false,
          version: false,
          stateDir,
          tenant: 'team-a',
          runId: 'run-a',
          session: 'doublespeed-ios',
        },
        client: {} as AgentDeviceClient,
      });
    });

    const state = readRequiredActiveState(stateDir);
    assert.equal(state.session, 'doublespeed-ios');
    assert.equal(state.leaseBackend, 'ios-instance');
    assert.equal(state.leaseProvider, 'doublespeed');
    assert.equal(state.platform, 'ios');
    assert.equal(state.daemon?.baseUrl, undefined);
    assert.match(
      state.remoteConfigPath,
      /remote-connections\/generated\/doublespeed-[a-f0-9]{16}\.json$/,
    );
    assert.deepEqual(readGeneratedConfigKeys(state.remoteConfigPath), [
      'clientId',
      'daemonTransport',
      'leaseBackend',
      'leaseProvider',
      'platform',
      'runId',
      'session',
      'sessionIsolation',
      'stateDir',
      'target',
      'tenant',
    ]);
    assert.equal(mockedVerifyDoublespeedConnection.mock.calls.length, 1);
    assert.equal(mockedVerifyDoublespeedConnection.mock.calls[0]?.[0]?.apiKey, 'dsx_test_key');

    await assert.rejects(
      connectCommand({
        positionals: ['doublespeed'],
        flags: {
          json: true,
          help: false,
          version: false,
          stateDir,
          platform: 'android',
          session: 'doublespeed-android',
          force: true,
        },
        client: {} as AgentDeviceClient,
      }),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

async function captureConnectStdout(run: () => Promise<void>): Promise<void> {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await run();
  } finally {
    write.mockRestore();
  }
}
function readRequiredActiveState(stateDir: string): RemoteConnectionState {
  const state = readActiveConnectionState({ stateDir });
  assert.ok(state);
  return state;
}
function readGeneratedConfigKeys(configPath: string): string[] {
  return Object.keys(JSON.parse(fs.readFileSync(configPath, 'utf8')));
}
