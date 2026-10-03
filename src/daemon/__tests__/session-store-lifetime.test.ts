import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { makeSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';

const ADDRESS = 'cwd:worktree:default';

function ended(error: unknown): boolean {
  return error instanceof AppError && error.details?.reason === 'session_lifetime_ended';
}

test('refs capture records while resolving rebuilds from the same lifetime', () => {
  const store = makeSessionStore();
  const session = makeSession('default');
  const initial = store.publish(ADDRESS, session);
  const lookup = store.lookup(ADDRESS)!;
  const listed = store.listRefs()[0]!;
  const byDevice = store.findByDevice(session.device.id)!;
  for (const ref of [lookup, listed, byDevice]) {
    assert.notEqual(ref, initial);
    assert.equal(ref.lifetime, initial.lifetime);
    assert.equal(ref.session, session);
    assert.equal(Object.isFrozen(ref), true);
  }
  const rebuilt = store.update(initial, { appName: 'Reopened' });
  assert.equal(initial.session, session);
  assert.equal(initial.session.appName, undefined);
  for (const ref of [initial, lookup, listed, byDevice]) {
    assert.equal(store.resolveCurrent(ref), rebuilt);
  }
  assert.equal(store.lookup(ADDRESS)?.session, rebuilt);
  const refreshed = store.refresh(initial);
  assert.equal(refreshed.lifetime, initial.lifetime);
  assert.equal(refreshed.session, rebuilt);
  assert.equal(initial.session, session);
  assert.equal(store.get('default'), undefined);
});

test('updates derive from the latest matching record and preserve intervening fields', () => {
  const store = makeSessionStore();
  const ref = store.publish(ADDRESS, makeSession('default', { createdAt: 10 }));
  store.update(ref, { appBundleId: 'com.example.updated' });
  store.update(ref, (current) => ({
    appName: current.appBundleId,
    createdAt: current.createdAt + 1,
  }));
  assert.equal(store.get(ADDRESS)?.appBundleId, 'com.example.updated');
  assert.equal(store.get(ADDRESS)?.appName, 'com.example.updated');
  assert.equal(store.get(ADDRESS)?.createdAt, 11);
  assert.equal(store.get(ADDRESS)?.actions, ref.session.actions);
});

test('address reuse with the same record still starts a different lifetime', () => {
  const store = makeSessionStore();
  const session = makeSession('default');
  const old = store.publish(ADDRESS, session);
  assert.equal(store.retire(old), true);
  const successor = store.publish(ADDRESS, session);
  store.setRuntimeHints(ADDRESS, { metroPort: 8082 });
  assert.notEqual(successor.lifetime, old.lifetime);
  assert.equal(store.resolveCurrent(old), undefined);
  assert.equal(store.refresh(old), old);
  assert.throws(() => store.requireCurrent(old), ended);
  assert.throws(() => store.update(old, { appName: 'Stale' }), ended);
  assert.equal(store.retire(old), false);
  assert.equal(store.get(ADDRESS), session);
  assert.equal(store.getRuntimeHints(ADDRESS)?.metroPort, 8082);
  assert.equal(store.retire(successor), true);
  assert.equal(store.getRuntimeHints(ADDRESS), undefined);
});

test('retired updates cannot run their derivation or resurrect a record', () => {
  const store = makeSessionStore();
  const ref = store.publish(ADDRESS, makeSession('default'));
  store.retire(ref);
  let ran = false;
  assert.throws(
    () =>
      store.update(ref, () => {
        ran = true;
        return { appName: 'Late' };
      }),
    ended,
  );
  assert.equal(ran, false);
  assert.equal(store.lookup(ADDRESS), undefined);
});

test('an occupied address cannot be published again', () => {
  const store = makeSessionStore();
  const ref = store.publish(ADDRESS, makeSession('default'));
  assert.throws(
    () => store.publish(ADDRESS, makeSession('default')),
    (error) => error instanceof AppError && error.details?.reason === 'session_address_occupied',
  );
  assert.equal(store.requireCurrent(ref), ref.session);
});

test('shutdown closes draft admission while allowing the current lifetime to settle', () => {
  const store = makeSessionStore();
  const ref = store.publish(ADDRESS, makeSession('default'));
  store.closeAdmission();
  assert.throws(
    () => store.publish('late-draft', makeSession('late-draft')),
    (error) => error instanceof AppError && error.details?.reason === 'daemon_shutting_down',
  );
  store.update(ref, { appName: 'Settled' });
  assert.equal(store.requireCurrent(ref).appName, 'Settled');
  assert.equal(store.retire(ref), true);
  assert.equal(store.lookup('late-draft'), undefined);
});

test('a ref from another store has no authority over the same address', () => {
  const source = makeSessionStore();
  const target = makeSessionStore();
  const foreign = source.publish(ADDRESS, makeSession('default'));
  const local = target.publish(ADDRESS, foreign.session);
  assert.equal(target.resolveCurrent(foreign), undefined);
  assert.throws(() => target.update(foreign, { appName: 'Foreign' }), ended);
  assert.equal(target.retire(foreign), false);
  assert.equal(target.requireCurrent(local), foreign.session);
});
