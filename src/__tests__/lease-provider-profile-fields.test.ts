import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import {
  errorResponse,
  type DaemonRequest,
  type DaemonResponse,
} from '@agent-device/kernel/contracts';
import { LimrunRuntime } from '../sdk/limrun.ts';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import { handleLeaseCommands } from '../daemon/handlers/lease.ts';
import { LeaseRegistry } from '../daemon/lease-registry.ts';
import { createProviderDeviceRuntimeRequestProviders } from '../provider-device-runtime.ts';
import {
  hashRemoteConfigFile,
  writeRemoteConnectionState,
} from '../remote/remote-connection-state.ts';
import { createTransport } from './client-transport-fixture.ts';
import { runCliCapture } from './cli-capture.ts';
import { makeTempWorkspace } from './cli-config-fixtures.ts';
import { makeSessionStore } from './test-utils/store-factory.ts';

const limrunInstances = vi.hoisted(() => ({
  iosCreate: vi.fn(async () => {
    throw new Error('a refused allocation must not create a Limrun instance');
  }),
}));

vi.mock('@limrun/api', () => ({
  default: class MockLimrun {
    readonly iosInstances = { create: limrunInstances.iosCreate };
  },
}));

afterEach(() => {
  vi.clearAllMocks();
});

// The daemon's lease handler over the same provider composition a daemon builds, so a request
// reaches the Limrun runtime exactly as it does in production.
function limrunDaemon(): (req: Omit<DaemonRequest, 'token'>) => Promise<DaemonResponse> {
  const runtime = new LimrunRuntime({ apiKey: 'lim_test_key' });
  const providers = createProviderDeviceRuntimeRequestProviders([runtime]);
  const leaseRegistry = new LeaseRegistry();
  const sessionStore = makeSessionStore('agent-device-limrun-profile-fields-');
  return async (req) => {
    try {
      return (await handleLeaseCommands({
        req: { ...req, token: 'test-token' } as Parameters<typeof handleLeaseCommands>[0]['req'],
        sessionName: req.session ?? 'default',
        sessionStore,
        leaseRegistry,
        providerRuntimeIds: providers.providerRuntimeIds,
        providerRuntimeRequiredIds: providers.providerRuntimeRequiredIds,
        leaseLifecycleProvider: providers.leaseLifecycleProvider,
      })) as DaemonResponse;
    } catch (error) {
      const normalized = normalizeError(error);
      return errorResponse(normalized.code, normalized.message, normalized.details);
    }
  };
}

test('leases.allocate refuses an OS version Limrun cannot honour instead of ignoring it', async () => {
  const setup = createTransport(limrunDaemon());
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await assert.rejects(
    client.leases.allocate({
      tenant: 'limrun',
      runId: 'run-os-version',
      leaseBackend: 'ios-instance',
      leaseProvider: 'limrun',
      platform: 'ios',
      providerOsVersion: '18.0',
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /--provider-os-version is not supported by Limrun/.test(error.message),
  );
  assert.equal(limrunInstances.iosCreate.mock.calls.length, 0);
});

test('a remote-config profile cannot carry a field Limrun refuses past lease allocation', async () => {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const remoteConfig = path.join(project, 'limrun.remote.json');
  fs.writeFileSync(remoteConfig, JSON.stringify({ providerGeoLocation: 'US' }), 'utf8');
  const now = new Date().toISOString();
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'limrun-profile',
      remoteConfigPath: remoteConfig,
      remoteConfigHash: hashRemoteConfigFile(remoteConfig),
      tenant: 'limrun',
      runId: 'run-profile',
      leaseBackend: 'ios-instance',
      leaseProvider: 'limrun',
      platform: 'ios',
      connectedAt: now,
      updatedAt: now,
    },
  });
  const daemon = limrunDaemon();

  try {
    const result = await runCliCapture(['open', '--state-dir', stateDir, '--json'], {
      cwd: project,
      env: { HOME: home },
      sendToDaemon: async (req) => await daemon(req),
    });

    assert.equal(result.code, 1);
    assert.equal(result.calls[0]?.command, 'lease_allocate');
    assert.equal(result.calls[0]?.flags?.providerGeoLocation, 'US');
    assert.match(result.stdout, /--provider-geo-location is not supported by Limrun/);
    assert.equal(limrunInstances.iosCreate.mock.calls.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
