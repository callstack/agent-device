import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  makeSession,
  makeRepairCompleteSession,
  makeRepairArmedSession,
  authoringPublication,
} from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore, storeSessionForTest } from '../../__tests__/test-utils/store-factory.ts';
import { resolveRepairTombstonePath } from '../../session-repair-tombstone.ts';

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

test('script writes use the latest matching record and refuse a retired lifetime', () => {
  const store = makeSessionStore();
  const ref = store.publish(ADDRESS, makeSession('default'));
  store.update(ref, {
    scriptPublication: authoringPublication('armed'),
    actions: [{ ts: 1, command: 'click', positionals: ['id="late-action"'], flags: {} }],
  });
  const result = store.writeSessionLog(ref);
  assert.equal(result.written, true);
  if (result.written) assert.match(fs.readFileSync(result.path, 'utf8'), /late-action/);
  store.retire(ref);
  const successor = store.publish(ADDRESS, makeRepairCompleteSession('default'));
  assert.throws(() => store.writeSessionLog(ref), ended);
  store.finalizeRepairTeardown(ref);
  const state = store.requireCurrent(successor).scriptPublication;
  assert.equal(state?.kind, 'repair');
  if (state?.kind === 'repair') assert.equal(state.status, 'complete');
  assert.equal(successor.session.actions.length, 0);
});

test('repair tombstones follow the scoped address and cannot be written by a retired ref', () => {
  const store = makeSessionStore();
  const ref = store.publish(ADDRESS, makeRepairArmedSession('default'));
  store.update(ref, {
    scriptPublication: {
      kind: 'repair',
      status: 'armed',
      boundary: 0,
      target: { kind: 'default', force: false },
      sourcePath: '/latest.ad',
    },
  });
  store.writeRepairTombstone(ref);
  assert.equal(store.readRepairTombstone(ADDRESS)?.owner, ADDRESS);
  assert.equal(store.readRepairTombstone(ADDRESS)?.sourcePath, '/latest.ad');
  assert.equal(store.readRepairTombstone('default'), undefined);
  store.retire(ref);
  store.clearRepairTombstone(ADDRESS);
  const successor = store.publish(ADDRESS, makeRepairArmedSession('default'));
  store.writeRepairTombstone(ref);
  assert.equal(store.readRepairTombstone(ADDRESS), undefined);
  assert.equal(store.requireCurrent(successor), successor.session);
});

test('test session publication uses its explicit scoped address', () => {
  const store = makeSessionStore();
  const session = makeSession('default');
  const ref = store.publish(ADDRESS, session);
  const stored = storeSessionForTest(store, session, ADDRESS);
  assert.equal(stored.lifetime, ref.lifetime);
  assert.equal(stored.session, session);
  assert.equal(store.get('default'), undefined);
  assert.equal(store.listRefs().length, 1);
});

test('colliding artifact directories cannot share or clear another address\u2019s repair tombstone', () => {
  const store = makeSessionStore();
  const collision = 'cwd_worktree_default';
  const ref = store.publish(ADDRESS, makeRepairArmedSession('default'));
  assert.equal(store.resolveSessionDir(ADDRESS), store.resolveSessionDir(collision));
  store.writeRepairTombstone(ref);
  assert.equal(store.readRepairTombstone(ADDRESS)?.owner, ADDRESS);
  assert.equal(store.readRepairTombstone(collision), undefined);
  store.clearRepairTombstone(collision);
  assert.equal(store.readRepairTombstone(ADDRESS)?.owner, ADDRESS);
  store.clearRepairTombstone(ADDRESS);
  assert.equal(store.readRepairTombstone(ADDRESS), undefined);
});

test('tombstone cleanup retains malformed evidence and removes an expired owned marker', () => {
  const store = makeSessionStore();
  const tombstonePath = resolveRepairTombstonePath(store.resolveSessionDir(ADDRESS));
  fs.mkdirSync(store.resolveSessionDir(ADDRESS), { recursive: true });
  fs.writeFileSync(tombstonePath, '{');
  store.clearRepairTombstone(ADDRESS);
  assert.equal(fs.readFileSync(tombstonePath, 'utf8'), '{');
  fs.writeFileSync(tombstonePath, JSON.stringify({ owner: ADDRESS, expiresAt: 0, reapedAt: 0 }));
  store.clearRepairTombstone(ADDRESS);
  assert.equal(fs.existsSync(tombstonePath), false);
});
