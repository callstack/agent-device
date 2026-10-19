import { bindTestCommandHost, createTestHostEnvironment } from '@agent-device/test-kit';
import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  connectionWorkspace,
  createTestClient,
  recordedLeaseRelease,
  seedConnectionState,
} from '../../__tests__/remote-connection.fixtures.ts';

vi.mock('@agent-device/react-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/react-native')>()),
  stopMetroTunnel: vi.fn(),
}));

import { stopMetroTunnel } from '@agent-device/react-native';
import { materializeRemoteConnectionForCommand } from './connection-runtime.ts';

bindTestCommandHost();

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

test('deferred materialization stops the new Metro companion if state persistence fails', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-write-fail-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  const release = recordedLeaseRelease();
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-android',
      remoteConfigPath,
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'acme',
      runId: 'run-123',
      platform: 'android',
      metro: {
        projectRoot: '/tmp/old-project',
        profileKey: remoteConfigPath,
        consumerKey: 'adc-android',
      },
    },
  });

  const originalRenameSync = fs.renameSync.bind(fs);
  const writeFailure = new Error('state write failed');
  vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
    if (String(newPath).endsWith(path.join('remote-connections', 'adc-android.json'))) {
      throw writeFailure;
    }
    return originalRenameSync(oldPath, newPath);
  });

  await assert.rejects(
    async () =>
      await materializeRemoteConnectionForCommand({
        host: createTestHostEnvironment(),
        command: 'open',
        flags: {
          json: true,
          help: false,
          version: false,
          stateDir,
          remoteConfig: remoteConfigPath,
          daemonBaseUrl: 'https://daemon.example',
          tenant: 'acme',
          runId: 'run-123',
          session: 'adc-android',
          platform: 'android',
          metroPublicBaseUrl: 'https://sandbox.example.test',
          metroProxyBaseUrl: 'https://proxy.example.test',
        },
        client: createTestClient({ release: release.stub }),
      }),
    writeFailure,
  );

  assert.equal(vi.mocked(stopMetroTunnel).mock.calls.length, 1);
  assert.deepEqual(vi.mocked(stopMetroTunnel).mock.calls[0]?.[0], {
    projectRoot: '/tmp/project',
    profileKey: remoteConfigPath,
    consumerKey: 'adc-android',
  });
  assert.equal(release.request?.leaseId, 'lease-1');
  assert.equal(release.request?.tenant, 'acme');
  assert.equal(release.request?.runId, 'run-123');
  assert.equal(release.request?.leaseBackend, 'android-instance');

  fs.rmSync(tempRoot, { recursive: true, force: true });
});
