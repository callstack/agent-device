import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import {
  hashRemoteConfigFile,
  writeRemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { runCliCapture } from './cli-capture.ts';
import { makeTempWorkspace } from './cli-config-fixtures.ts';
import { startPublicDaemonRuntime } from './test-utils/public-daemon-runtime.ts';

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

test('leases.allocate refuses an OS version Limrun cannot honour instead of ignoring it', async () => {
  const daemon = await startPublicDaemonRuntime({
    serverMode: 'http',
    env: { LIMRUN_API_KEY: 'lim_test_key' },
  });
  try {
    const client = createAgentDeviceClient({
      daemonBaseUrl: daemon.baseUrl,
      daemonAuthToken: daemon.runtime.token,
      daemonTransport: 'http',
    });
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
        JSON.stringify(error.details?.flags) === '["--provider-os-version"]',
    );
    assert.equal(limrunInstances.iosCreate.mock.calls.length, 0);
  } finally {
    await daemon.close();
  }
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
  const daemon = await startPublicDaemonRuntime({
    serverMode: 'http',
    env: { LIMRUN_API_KEY: 'lim_test_key' },
  });

  try {
    const result = await runCliCapture(['open', '--state-dir', stateDir, '--json'], {
      cwd: project,
      env: {
        HOME: home,
        AGENT_DEVICE_DAEMON_BASE_URL: daemon.baseUrl,
        AGENT_DEVICE_DAEMON_AUTH_TOKEN: daemon.runtime.token,
      },
      useRealDaemonClient: true,
    });

    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, 'INVALID_ARGS');
    assert.deepEqual(payload.error.details.flags, ['--provider-geo-location']);
    assert.equal(limrunInstances.iosCreate.mock.calls.length, 0);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
