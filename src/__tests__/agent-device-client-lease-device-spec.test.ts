import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { createDaemonProxyServer } from '@agent-device/proxy';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { isInactiveLeaseError } from '@agent-device/contracts/lease-scope';
import { AppError } from '@agent-device/kernel/errors';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import { runCliCapture } from './cli-capture.ts';
import { makeTempWorkspace } from './cli-config-fixtures.ts';
import { startPublicDaemonRuntime } from './test-utils/public-daemon-runtime.ts';

const LEASE_ID = 'abcdef0123456789abcdef0123456789';

function isDeviceSpecRefusal(keys: string[]) {
  return (error: unknown) =>
    error instanceof AppError &&
    error.code === 'UNSUPPORTED_OPERATION' &&
    error.details?.reason === 'device-spec-unsupported' &&
    JSON.stringify(error.details?.keys) === JSON.stringify(keys);
}

async function assertNoLeaseRecorded(client: ReturnType<typeof createAgentDeviceClient>) {
  await assert.rejects(
    client.leases.heartbeat({
      tenant: 'proxy',
      runId: 'run-spec',
      leaseId: LEASE_ID,
      leaseBackend: 'ios-instance',
    }),
    (error: unknown) => isInactiveLeaseError(error),
  );
}

test('a daemon refuses a lease allocate naming a device spec and records no lease', async () => {
  const daemon = await startPublicDaemonRuntime({ serverMode: 'http' });
  try {
    const client = createAgentDeviceClient({
      daemonBaseUrl: daemon.baseUrl,
      daemonAuthToken: daemon.runtime.token,
      daemonTransport: 'http',
    });
    await assert.rejects(
      client.leases.allocate({
        tenant: 'proxy',
        runId: 'run-spec',
        leaseId: LEASE_ID,
        leaseBackend: 'ios-instance',
        platform: 'ios',
        osVersion: '>=26',
        physical: true,
      }),
      isDeviceSpecRefusal(['osVersion', 'physical']),
    );
    await assertNoLeaseRecorded(client);
    // The same allocate without the spec is recorded, so the heartbeat above proves the refusal.
    const lease = await client.leases.allocate({
      tenant: 'proxy',
      runId: 'run-spec',
      leaseId: LEASE_ID,
      leaseBackend: 'ios-instance',
      platform: 'ios',
    });
    assert.equal(lease.leaseId, LEASE_ID);
    assert.equal(lease.device, undefined);
  } finally {
    await daemon.close();
  }
});

test('a daemon behind agent-device proxy refuses a lease allocate naming a device spec', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const daemon = await startPublicDaemonRuntime({ serverMode: 'http' });
  const proxy = createDaemonProxyServer({
    upstreamBaseUrl: daemon.baseUrl,
    upstreamToken: daemon.runtime.token,
    clientToken: 'client-secret',
  });
  try {
    const proxyPort = await listenOnLoopback(proxy);
    const client = createAgentDeviceClient({
      daemonBaseUrl: `http://127.0.0.1:${proxyPort}/agent-device`,
      daemonAuthToken: 'client-secret',
      daemonTransport: 'http',
    });
    await assert.rejects(
      client.leases.allocate({
        tenant: 'proxy',
        runId: 'run-spec',
        leaseId: LEASE_ID,
        leaseBackend: 'android-instance',
        platform: 'android',
        imageTag: 'google_apis_playstore',
      }),
      isDeviceSpecRefusal(['imageTag']),
    );
    await assertNoLeaseRecorded(client);
  } finally {
    await closeLoopbackServer(proxy);
    await daemon.close();
  }
});

test('open --os against a local daemon fails with device-spec-unsupported', async () => {
  const { root, home, project } = makeTempWorkspace();
  const daemon = await startPublicDaemonRuntime({ serverMode: 'http' });
  try {
    const result = await runCliCapture(
      ['open', 'MyApp', '--platform', 'ios', '--os', '>=26', '--json'],
      {
        cwd: project,
        env: {
          HOME: home,
          AGENT_DEVICE_DAEMON_BASE_URL: daemon.baseUrl,
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: daemon.runtime.token,
        },
        useRealDaemonClient: true,
      },
    );

    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, 'UNSUPPORTED_OPERATION');
    assert.equal(payload.error.details.reason, 'device-spec-unsupported');
    assert.deepEqual(payload.error.details.keys, ['osVersion']);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
