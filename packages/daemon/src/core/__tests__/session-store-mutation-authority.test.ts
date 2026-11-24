import assert from 'node:assert/strict';
import { test } from 'vitest';
import { clearRequestCanceled, markRequestCanceled } from '@agent-device/host-kit/request';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DaemonRequest } from '../daemon-request.ts';
import { SessionCoordinator } from '../session-store.ts';
import { activateCompleteRefFrame, refFrameState } from '../ref-frame.ts';
import { makeSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Android',
  kind: 'emulator',
};

function request(requestId: string): DaemonRequest {
  return {
    token: 't',
    session: 'agent',
    command: 'find',
    positionals: ['Save', 'focus'],
    flags: {},
    meta: { requestId },
  };
}

function admittedMutation(requestId: string) {
  const store = makeSessionStore();
  const coordinator = new SessionCoordinator(store);
  const session = makeSession('agent', { device });
  const ref = store.publish('agent', session);
  const mutations = coordinator.mutate(request(requestId), ref, () => true);
  return { store, ref, mutations };
}

test.each(['cancellation', 'replacement'])(
  'a revoked mutation authority refuses every effect on %s',
  (reason) => {
    const requestId = `mutation-${reason}`;
    const { store, ref, mutations } = admittedMutation(requestId);
    const successor = makeSession('agent', { device, appBundleId: 'com.example.successor' });

    try {
      if (reason === 'cancellation') markRequestCanceled(requestId);
      if (reason === 'replacement') {
        store.retire(ref);
        store.publish('agent', successor);
      }

      // Observing the successor is refused, and the refusal names the revoked authority's own
      // situation rather than the session that now occupies the address.
      assert.throws(
        () => mutations.requireTargetContext(),
        (error) =>
          error instanceof AppError &&
          error.details?.reason ===
            (reason === 'cancellation' ? 'request_canceled' : 'session_lifetime_ended'),
      );
      // Crossing the side-effect seam is refused rather than silently skipped: a caller must not
      // read a no-op on a dead lifetime as its own expiry.
      assert.throws(() => mutations.expireRefFrame());
      // The one effect that stays quiet is the recording: its entry belongs to the lifetime that
      // ended with it, and attributing it to a successor would be the actual damage.
      mutations.recordAction({ command: 'find', positionals: ['Save', 'focus'], flags: {} });
      assert.deepEqual(successor.actions, []);
    } finally {
      clearRequestCanceled(requestId);
    }
  },
);

test('a stale authority cannot expire the ref frame of the session that replaced its own', () => {
  const requestId = 'mutation-stale-frame';
  const { store, ref, mutations } = admittedMutation(requestId);

  // Close and reopen the same address: the successor has its own active frame to lose.
  store.retire(ref);
  const successor = makeSession('agent', { device });
  store.publish('agent', successor);
  activateCompleteRefFrame(successor);

  // The stale capability answers with its own ended lifetime and leaves the successor's frame active:
  // expiring through an unresolved address is exactly the cross-lifetime damage the seam forbids.
  assert.throws(
    () => mutations.expireRefFrame(),
    (error) => error instanceof AppError,
  );
  assert.equal(refFrameState(successor), 'active');
});

test('a mutation authority answers with the current facts of the lifetime it was given', () => {
  const requestId = 'mutation-live-facts';
  const { store, ref, mutations } = admittedMutation(requestId);

  // The request's own `open` narrowed the admitted lifetime to an app after admission, so the read
  // has to follow that lifetime: this is why find builds its runtime context at dispatch time.
  const session = store.requireCurrent(ref);
  session.appBundleId = 'com.example.admitted';
  assert.equal(mutations.requireTargetContext().appBundleId, 'com.example.admitted');

  // Once that lifetime ends, the authority reports its own end rather than the successor's app scope.
  store.retire(ref);
  store.publish('agent', makeSession('agent', { device, appBundleId: 'com.example.successor' }));
  assert.throws(
    () => mutations.requireTargetContext(),
    (error) => error instanceof AppError && error.details?.reason === 'session_lifetime_ended',
  );
});
