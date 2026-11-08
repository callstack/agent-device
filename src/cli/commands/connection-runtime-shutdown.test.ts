import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { createTestHostEnvironment } from '@agent-device/test-kit';
import { readRemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import {
  connectionWorkspace,
  createTestClient,
  recordedLeaseAllocate,
  seedConnectionState,
  unexpectedCommandCall,
} from '../../__tests__/remote-connection.fixtures.ts';
import { materializeRemoteConnectionForCommand } from './connection-runtime.ts';

for (const platform of ['ios', 'android'] as const) {
  const leaseBackend = platform === 'ios' ? 'ios-instance' : 'android-instance';
  for (const leaseId of [undefined, 'existing-lease']) {
    test(`shutdown preserves the ${platform} connection's ${leaseId ?? 'unallocated'} lease without acquiring a device`, async () => {
      const { stateDir, remoteConfigPath } = connectionWorkspace('agent-device-shutdown-lease-');
      fs.writeFileSync(remoteConfigPath, JSON.stringify({ leaseProvider: 'limrun', platform }));
      seedConnectionState({
        stateDir,
        state: {
          session: 'shutdown-test',
          remoteConfigPath,
          tenant: 'acme',
          runId: 'shutdown-run',
          leaseProvider: 'limrun',
          platform,
          leaseBackend,
          leaseId,
        },
      });

      const result = await materializeRemoteConnectionForCommand({
        host: createTestHostEnvironment(),
        command: 'shutdown',
        flags: {
          json: true,
          help: false,
          version: false,
          session: 'shutdown-test',
          stateDir,
          remoteConfig: remoteConfigPath,
        },
        client: createTestClient({
          allocate: unexpectedCommandCall,
          heartbeat: unexpectedCommandCall,
          release: unexpectedCommandCall,
        }),
      });

      assert.equal(result.flags.leaseId, leaseId);
      assert.equal(result.connection?.leaseProvider, 'limrun');
      assert.equal(
        readRemoteConnectionState({ stateDir, session: 'shutdown-test' })?.leaseId,
        leaseId,
      );
    });
  }

  test(`boot still allocates a ${platform} instance on a fresh Limrun connection`, async () => {
    const { stateDir, remoteConfigPath } = connectionWorkspace('agent-device-boot-lease-');
    fs.writeFileSync(
      remoteConfigPath,
      JSON.stringify({ leaseProvider: 'limrun', platform, tenant: 'acme', runId: 'boot-run' }),
    );
    const allocation = recordedLeaseAllocate({ leaseId: 'created-lease', backend: leaseBackend });
    const result = await materializeRemoteConnectionForCommand({
      host: createTestHostEnvironment(),
      command: 'boot',
      flags: {
        json: true,
        help: false,
        version: false,
        session: 'boot-test',
        stateDir,
        remoteConfig: remoteConfigPath,
      },
      client: createTestClient({ allocate: allocation.stub }),
    });
    assert.equal(result.flags.leaseId, 'created-lease');
    assert.equal(
      readRemoteConnectionState({ stateDir, session: 'boot-test' })?.leaseId,
      'created-lease',
    );
    assert.equal(allocation.request?.leaseBackend, leaseBackend);
  });
}
