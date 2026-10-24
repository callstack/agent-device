import path from 'node:path';
import { expect, test } from 'vitest';
import { resourceAdmissionWorld, assertRpcOk } from './composite-resource-admission.fixtures.ts';
import { seedExistingCapture } from './composite-resource-existing.fixtures.ts';

test('provider-releasing close refuses while reopen keeps the provider lease', async () => {
  const world = await resourceAdmissionWorld('capture', { withLifecycleProvider: true });
  try {
    const lease = world.leaseRegistry.allocateLease({ tenantId: 'tenant-a', runId: 'run-a' });
    world.sessionStore.update(world.ref, {
      lease: {
        leaseId: lease.leaseId,
        tenantId: lease.tenantId,
        runId: lease.runId,
        leaseBackend: lease.backend,
      },
    });
    const close = await world.call('batch', [], { batchSteps: [{ command: 'close' }] });
    expect(close.json.error, JSON.stringify(close.json)).toBeDefined();
    expect(close.json.error?.data?.details).toMatchObject({
      reason: 'bounded_composite_resource_unsupported',
      shape: 'session-resource-disposal:provider-lease',
      dispatched: 'no',
    });
    expect(world.bind).not.toHaveBeenCalled();
    assertRpcOk(
      await world.call('batch', [], {
        batchSteps: [{ command: 'open', positionals: ['com.android.settings'] }],
      }),
    );
    expect(world.providerRelease).not.toHaveBeenCalled();
  } finally {
    await world.daemon.close();
  }
});

test.each(['batch', 'replay'] as const)(
  '%s refuses expired own lease without inline resource cleanup',
  async (composite) => {
    const world = await resourceAdmissionWorld();
    try {
      const owned = seedExistingCapture(world, 'audio-probe');
      const lease = world.leaseRegistry.allocateLease({ tenantId: 'tenant-a', runId: 'run-a' });
      world.sessionStore.update(world.ref, {
        lease: {
          leaseId: lease.leaseId,
          tenantId: lease.tenantId,
          runId: lease.runId,
          leaseBackend: lease.backend,
        },
      });
      world.expireLease();
      const script = path.join(world.daemon.stateDir, 'expired.ad');
      const response = await world.call(
        composite,
        composite === 'replay' ? [script] : [],
        composite === 'replay'
          ? { replayScriptSource: { entry: script, files: { [script]: 'home\n' } } }
          : { batchSteps: [{ command: 'home' }] },
      );
      expect(response.json.error?.data).toMatchObject({
        code: 'UNAUTHORIZED',
        details: { reason: 'LEASE_NOT_FOUND', dispatched: 'no' },
      });
      expect(world.bind).not.toHaveBeenCalled();
      expect(owned.finish).not.toHaveBeenCalled();
      expect(world.sessionStore.requireCurrent(world.ref)).toMatchObject(owned.patch);
      expect(world.leaseRegistry.consumeExpiredLease(lease.leaseId)?.leaseId).toBe(lease.leaseId);
    } finally {
      await world.daemon.close();
    }
  },
);
