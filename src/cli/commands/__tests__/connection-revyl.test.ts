import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { mkdtempForTestSync, pluginHome, selectPlugin } from '@agent-device/test-kit';
import type { CliFlags } from '@agent-device/contracts/command';
import { AppError } from '@agent-device/kernel/errors';
import { readActiveConnectionState } from '@agent-device/remote/remote-connection-state';
import { resolveProviderPlugins } from '@agent-device/plugins/registry';
import type { PluginConnectionCallbacks } from '@agent-device/plugins/connection';
import revyl from '@agent-device/revyl';
import manifest from '@agent-device/revyl/package.json' with { type: 'json' };
import { resolveConnectProviderProfile } from '../../connection/connect-provider-adapters.ts';
import { connectWithGeneratedProviderProfile } from '../../../__tests__/test-utils/connect-command.ts';

// Mirrors src/__tests__/cloud-connect-testmu.test.ts: the plugin store is told the Revyl plugin is
// installed and its connection callbacks are loaded from the workspace source, so the assertions read
// the HTTP the plugin really sends rather than a mock of it.
const mockedWithPluginConnection = vi.hoisted(() => vi.fn());

vi.mock('@agent-device/plugins/load', () => ({
  withPluginConnection: mockedWithPluginConnection,
}));

type FakeRevylBackend = Readonly<{
  backendUrl: string;
  /** Requests in arrival order, each spelled `METHOD /path`. */
  paths(): string[];
  authorizationAt(index: number): string | undefined;
  close(): Promise<void>;
}>;

const backends: FakeRevylBackend[] = [];

/** Answers the one call connect verification makes, and records what the plugin sent. */
async function startRevylVerificationStub(): Promise<FakeRevylBackend> {
  const requests: Array<{ key: string; authorization: string | undefined }> = [];
  const server = http.createServer((request, response) => {
    requests.push({
      key: `${request.method} ${request.url}`,
      authorization: request.headers.authorization,
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ uuid: 'user-1' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const backend = {
    backendUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    paths: () => requests.map((request) => request.key),
    authorizationAt: (index: number) => requests[index]?.authorization,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  backends.push(backend);
  vi.stubEnv('REVYL_API_URL', backend.backendUrl);
  mockedWithPluginConnection.mockImplementation(
    async (
      _provider: string,
      _builtinProviders: readonly string[],
      _env: NodeJS.ProcessEnv,
      runConnection: (connection: PluginConnectionCallbacks) => Promise<unknown>,
    ) => {
      const { connections } = await resolveProviderPlugins([
        { source: 'store', package: manifest.name, load: () => revyl() },
      ]);
      return await runConnection(connections.get('revyl')!);
    },
  );
  return backend;
}

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(backends.splice(0).map((backend) => backend.close()));
});

beforeEach(() => {
  const { home } = pluginHome();
  selectPlugin(home, manifest.name, 'revyl', 'export default () => {};');
  const { installation } = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))
    .plugins[manifest.name];
  const manifestPath = path.join(
    home,
    'plugins',
    installation,
    'node_modules',
    manifest.name,
    'package.json',
  );
  const declared = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  declared.agentDevicePlugin.connection = manifest.agentDevicePlugin.connection;
  fs.writeFileSync(manifestPath, JSON.stringify(declared));
  vi.stubEnv('AGENT_DEVICE_HOME', home);
  vi.stubEnv('REVYL_API_KEY', 'rk_test');
  vi.stubEnv('REVYL_API_URL', '');
});

const connectFlags = {
  platform: 'ios' as const,
  device: 'iPhone 16',
  providerOsVersion: '18.0',
  providerApp: 'https://apps.test/app.zip',
};

function resolveProfile(
  tempRoot: string,
  flags: Partial<CliFlags>,
  env: Record<string, string> = { REVYL_API_KEY: 'rk_test' },
) {
  return resolveConnectProviderProfile({
    provider: 'revyl',
    stateDir: path.join(tempRoot, '.state'),
    cwd: tempRoot,
    env,
    flags: { json: false, help: false, version: false, ...connectFlags, ...flags },
  });
}

test('connect revyl verifies credentials and stores a profile without renting a device', async () => {
  const backend = await startRevylVerificationStub();
  const tempRoot = mkdtempForTestSync('agent-device-connect-revyl-');
  const stateDir = path.join(tempRoot, '.state');

  try {
    await connectWithGeneratedProviderProfile({
      stateDir,
      positionals: ['revyl'],
      flags: connectFlags,
    });

    // Verification is the cheap authenticated call: a profile is saved, no device is started.
    assert.deepEqual(backend.paths(), ['GET /api/v1/entity/users/get_user_uuid']);
    assert.equal(backend.authorizationAt(0), 'Bearer rk_test');

    const state = readActiveConnectionState({ stateDir });
    assert.ok(state);
    assert.equal(state.tenant, 'revyl');
    assert.equal(state.leaseProvider, 'revyl');
    assert.match(state.remoteConfigPath, /generated\/revyl-[a-f0-9]{16}\.json$/);
    const generated = JSON.parse(fs.readFileSync(state.remoteConfigPath, 'utf8')) as {
      providerApp?: string;
      providerOsVersion?: string;
    };
    assert.equal(generated.providerApp, 'https://apps.test/app.zip');
    assert.equal(generated.providerOsVersion, '18.0');
    // The API key never lands in the profile written to disk.
    assert.equal(JSON.stringify(generated).includes('rk_test'), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('connect revyl refuses a missing API key before calling the backend', async () => {
  const backend = await startRevylVerificationStub();
  const tempRoot = mkdtempForTestSync('agent-device-connect-revyl-no-key-');

  try {
    await assert.rejects(
      resolveProfile(tempRoot, {}, { REVYL_API_KEY: '', REVYL_API_URL: '' }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'INVALID_ARGS');
        assert.match(error.message, /requires a Revyl API key/);
        assert.equal(error.details?.reason, 'missing_provider_credentials');
        assert.deepEqual(error.details?.variables, ['REVYL_API_KEY']);
        return true;
      },
    );
    assert.deepEqual(backend.paths(), []);
    assert.equal(fs.existsSync(path.join(tempRoot, '.state')), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('connect revyl refuses a local app path and a device type before saving a profile', async () => {
  const backend = await startRevylVerificationStub();
  const tempRoot = mkdtempForTestSync('agent-device-connect-revyl-refusals-');

  try {
    await assert.rejects(
      resolveProfile(tempRoot, { providerApp: 'local/App.app' }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'INVALID_ARGS');
        assert.match(error.message, /https URL/);
        return true;
      },
    );
    await assert.rejects(
      resolveProfile(tempRoot, { providerDeviceType: 'real' }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'INVALID_ARGS');
        assert.match(error.message, /^--provider-device-type is not supported by Revyl/);
        return true;
      },
    );
    // A refused profile never reaches the backend or the state directory.
    assert.deepEqual(backend.paths(), []);
    assert.equal(fs.existsSync(path.join(tempRoot, '.state')), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
