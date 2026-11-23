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

test.each(['cancellation', 'replacement'])('observation authority revokes on %s', (reason) => {
  const store = makeSessionStore();
  const coordinator = new SessionCoordinator(store);
  const session = makeSession('agent', { device });
  const ref = store.publish('agent', session);
  const req = request(`observation-${reason}`);
  const observation = coordinator.observeDevice(
    req,
    device,
    () => true,
    () => {},
  );

  try {
    if (reason === 'cancellation') markRequestCanceled(req.meta!.requestId!);
    if (reason === 'replacement') {
      store.retire(ref);
      store.publish('agent', session);
    }
    assert.throws(() => observation.assertCurrent());
  } finally {
    clearRequestCanceled(req.meta!.requestId!);
  }
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
