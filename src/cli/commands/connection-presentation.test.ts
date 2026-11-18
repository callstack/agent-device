import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import { presentConnectReadiness } from './connection-presentation.ts';

test('connect guides a deferred device without an app to install a local file in its session', () => {
  const state: RemoteConnectionState = {
    version: 1,
    session: 'checkout',
    tenant: 'mobile',
    runId: 'local',
    platform: 'android',
    remoteConfigPath: '/workspace/remote.json',
    remoteConfigHash: 'fixture',
    connectedAt: '2026-11-18T00:00:00Z',
    updatedAt: '2026-11-18T00:00:00Z',
  };
  const readiness = presentConnectReadiness(
    state,
    {
      provider: 'fixture-provider',
      service: 'Fixture Provider',
      verificationMessage: 'Credentials verified.',
      device: { status: 'deferred', platform: 'android' },
      app: { status: 'missing' },
    },
    {},
  );

  assert.deepEqual(readiness.nextSteps, [
    'agent-device install <package-id> <app-path> --session checkout',
    'agent-device open <package-id> --relaunch --session checkout',
  ]);
});
