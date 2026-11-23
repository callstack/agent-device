import assert from 'node:assert/strict';
import { test } from 'vitest';
import { clearRequestCanceled, markRequestCanceled } from '@agent-device/host-kit/request';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DaemonRequest } from '../daemon-request.ts';
import { SessionCoordinator } from '../session-store.ts';
import { makeSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Android',
  kind: 'emulator',
};

function request(requestId = 'snapshot-observation'): DaemonRequest {
  return {
    token: 't',
    session: 'default',
    command: 'snapshot',
    positionals: [],
    flags: { snapshotObserveOnly: true, serial: device.id },
    meta: { requestId },
  };
}

test('an observation borrows the exact admitted lifetime without publishing a session', () => {
  const store = makeSessionStore();
  const coordinator = new SessionCoordinator(store);
  const session = makeSession('agent', { device });
  const ref = store.publish('agent', session);
  let admitted = false;
  const observation = coordinator.observeDevice(
    request(),
    device,
    () => true,
    (owner) => {
      assert.equal(owner, session);
      admitted = true;
    },
  );

  observation.assertCurrent();
  assert.equal(admitted, true);
  assert.equal(store.lookup('default'), undefined);
  assert.equal(store.lookup('agent')?.lifetime, ref.lifetime);
  assert.equal(store.lookup('agent')?.session, session);
});

test.each(['callback exit', 'cancellation', 'replacement'])(
  'observation authority revokes on %s',
  (reason) => {
    const store = makeSessionStore();
    const coordinator = new SessionCoordinator(store);
    const session = makeSession('agent', { device });
    const ref = store.publish('agent', session);
    const req = request(`observation-${reason}`);
    let active = true;
    const observation = coordinator.observeDevice(
      req,
      device,
      () => active,
      () => {},
    );

    try {
      if (reason === 'callback exit') active = false;
      if (reason === 'cancellation') markRequestCanceled(req.meta!.requestId!);
      if (reason === 'replacement') {
        store.retire(ref);
        store.publish('agent', session);
      }
      assert.throws(() => observation.assertCurrent());
    } finally {
      clearRequestCanceled(req.meta!.requestId!);
    }
  },
);

test('a detached observation has revocable request authority without a session', () => {
  const store = makeSessionStore();
  const coordinator = new SessionCoordinator(store);
  let active = true;
  const observation = coordinator.observeDevice(
    request(),
    device,
    () => active,
    (owner) => {
      assert.equal(owner, undefined);
    },
  );
  observation.assertCurrent();
  assert.deepEqual(store.listRefs(), []);
  active = false;
  assert.throws(() => observation.assertCurrent());
});

test('an observation cannot inspect a leased helper without the producing lease', () => {
  const store = makeSessionStore();
  const coordinator = new SessionCoordinator(store);
  const session = makeSession('agent', {
    device,
    lease: { backend: 'android-instance', leaseId: 'owner', tenantId: 'tenant', runId: 'run' },
  });
  store.publish('agent', session);
  let inspected = false;
  assert.throws(
    () =>
      coordinator.observeDevice(
        request(),
        device,
        () => true,
        () => {
          inspected = true;
        },
      ),
    (error) => error instanceof AppError && error.code === 'UNAUTHORIZED',
  );
  assert.equal(inspected, false);
});
