import assert from 'node:assert/strict';
import { test } from 'vitest';
import { handleLeaseCommands } from '../lease.ts';
import { LeaseRegistry } from '../../lease-registry.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { AppError } from '@agent-device/kernel/errors';
import { clearRequestCanceled, markRequestCanceled } from '@agent-device/host-kit/request';
import {
  HUMAN_CONTROL_LEASE_REQUEST,
  HUMAN_CONTROL_SCOPE,
  createControlLatch,
  humanControlRequest,
} from '../../__tests__/human-control-fixtures.ts';

for (const operation of ['allocate', 'release'] as const) {
  test(`host activation drains provider lease ${operation} before reporting active`, async () => {
    const registry = new LeaseRegistry();
    const lease = registry.allocateLease(HUMAN_CONTROL_LEASE_REQUEST);
    const started = createControlLatch();
    const finish = createControlLatch();
    const request = humanControlRequest(lease, `lease_${operation}`, []);
    const mutation = handleLeaseCommands({
      req: request,
      sessionName: request.session,
      sessionStore: makeSessionStore('agent-device-held-provider-'),
      leaseRegistry: registry,
      leaseLifecycleProvider: {
        [operation]: async () => {
          started.resolve();
          await finish.promise;
          return {};
        },
      },
    });
    await started.promise;
    let active = false;
    const activation = registry
      .putHumanControlHold({ kind: 'host' }, 'host', { scope: HUMAN_CONTROL_SCOPE })
      .then(() => {
        active = true;
      });
    await Promise.resolve();
    assert.equal(active, false);
    finish.resolve();
    assert.equal((await mutation)?.ok, true);
    await activation;
    assert.equal(active, true);
  });
}

test('activation drains canceled provider allocation and its release cleanup', async () => {
  const registry = new LeaseRegistry();
  const lease = registry.allocateLease(HUMAN_CONTROL_LEASE_REQUEST);
  const started = createControlLatch();
  const finish = createControlLatch();
  const request = humanControlRequest(lease, 'lease_allocate', []);
  const requestId = 'held-canceled-allocation';
  request.meta = { ...request.meta, requestId };
  let providerReleased = false;
  const mutation = handleLeaseCommands({
    req: request,
    sessionName: request.session,
    sessionStore: makeSessionStore('agent-device-held-canceled-provider-'),
    leaseRegistry: registry,
    leaseLifecycleProvider: {
      allocate: async () => {
        started.resolve();
        await finish.promise;
        markRequestCanceled(requestId);
        return {};
      },
      release: async () => {
        assert.equal(registry.listHumanControlHolds({ kind: 'host' })[0]?.state, 'activating');
        providerReleased = true;
        return {};
      },
    },
  });
  await started.promise;
  const activation = registry.putHumanControlHold({ kind: 'host' }, 'host', {
    scope: HUMAN_CONTROL_SCOPE,
  });
  finish.resolve();
  try {
    await assert.rejects(
      mutation,
      (error: unknown) => error instanceof AppError && error.details?.released === true,
    );
    await activation;
    assert.equal(providerReleased, true);
    assert.equal(registry.listActiveLeases().length, 0);
  } finally {
    clearRequestCanceled(requestId);
  }
});
