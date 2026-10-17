import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, vi } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { createAgentDeviceClient } from './agent-device-client.ts';
import { mkdtempForTestSync, skipWhenLoopbackUnavailable } from '@agent-device/test-kit';
import { startPublicDaemonRuntime } from './__tests__/test-utils/public-daemon-runtime.ts';

const limrun = vi.hoisted(() => ({
  iosCreate: vi.fn(async () => ({
    metadata: { id: 'ios-instance-1' },
    status: { token: 'instance-token', apiUrl: 'https://ios.example' },
  })),
  iosList: vi.fn(async () => ({ getPaginatedItems: () => [] as { metadata: { id: string } }[] })),
  iosDelete: vi.fn(async (_instanceId: string) => undefined),
  iosDisconnect: vi.fn(),
}));

vi.mock('@limrun/api', () => ({
  default: class MockLimrun {
    readonly iosInstances = {
      create: limrun.iosCreate,
      list: limrun.iosList,
      delete: limrun.iosDelete,
    };
  },
}));

vi.mock('@limrun/api/ios-client', () => ({
  createInstanceClient: vi.fn(async () => ({ disconnect: limrun.iosDisconnect })),
}));

test('Limrun retries an expired provider lease persisted by a daemon before restart', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const stateDir = mkdtempForTestSync('agent-device-limrun-expired-lease-restart-');
  const env = { LIMRUN_API_KEY: 'lim_test_key', AGENT_DEVICE_LEASE_MIN_TTL_MS: '1' };
  let now = Date.now();
  const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now);
  let firstDaemon: Awaited<ReturnType<typeof startPublicDaemonRuntime>> | undefined;
  let restartedDaemon: Awaited<ReturnType<typeof startPublicDaemonRuntime>> | undefined;

  try {
    firstDaemon = await startPublicDaemonRuntime({ stateDir, env });
    const client = createAgentDeviceClient({ stateDir, daemonTransport: 'http' });
    const lease = await client.leases.allocate({
      tenant: 'team-a',
      runId: 'run-a',
      leaseBackend: 'ios-instance',
      leaseProvider: 'limrun',
      platform: 'ios',
      ttlMs: 1,
    });
    now += 2;
    limrun.iosList.mockResolvedValue({
      getPaginatedItems: () => [{ metadata: { id: 'ios-instance-recovered' } }],
    });
    limrun.iosDelete.mockRejectedValue(new Error('temporary provider outage'));

    assert.equal(
      (
        await client.leases.release({
          leaseId: lease.leaseId,
          tenant: 'team-a',
          runId: 'run-a',
          leaseBackend: 'ios-instance',
          leaseProvider: 'limrun',
        })
      ).released,
      false,
    );
    await vi.waitFor(() => assert.ok(limrun.iosDelete.mock.calls.length > 0), {
      interval: 10,
      timeout: 2_000,
    });
    await firstDaemon.runtime.shutdown();
    assert.ok(limrun.iosDisconnect.mock.calls.length > 0);

    const pendingPath = path.join(stateDir, 'expired-provider-leases.json');
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as { leases: DeviceLease[] };
    assert.deepEqual(
      pending.leases.map(({ leaseId }) => leaseId),
      [lease.leaseId],
    );

    limrun.iosDelete.mockResolvedValue(undefined);
    restartedDaemon = await startPublicDaemonRuntime({ stateDir, env });
    await vi.waitFor(() => assert.ok(limrun.iosDelete.mock.calls.length > 1), {
      interval: 10,
      timeout: 2_000,
    });

    assert.deepEqual(limrun.iosList.mock.calls.at(-1), [
      { labelSelector: `provider=limrun,leaseId=${lease.leaseId}` },
    ]);
    assert.deepEqual(limrun.iosDelete.mock.calls.at(-1), ['ios-instance-recovered']);
    assert.equal(fs.existsSync(pendingPath), false);
  } finally {
    dateNow.mockRestore();
    if (restartedDaemon) {
      await restartedDaemon.close();
    } else {
      await firstDaemon?.runtime.shutdown();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }
});
