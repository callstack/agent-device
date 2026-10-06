/**
 * #1271 stage 2 (ADR 0012 amendment): `recordIfSession`'s classification of
 * which commands are observation-only for the repair-segment default
 * exclusion (`recordActionEntry`, `session-action-recorder.ts`). `get`/`is`/
 * a read-only `find` are observation-only; the top-level `wait` command is
 * deliberately excluded from that set (flow timing/synchronisation, not
 * observation) and must keep recording unconditionally even while
 * repair-armed.
 */
import { test, expect } from 'vitest';
import path from 'node:path';
import { recordIfSession } from '../selector-recording.ts';
import { SessionStore } from '../session-store.ts';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import type { DaemonRequest } from '../daemon-request.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

function makeStore(): SessionStore {
  const root = mkdtempForTestSync('agent-device-selector-recording-');
  return new SessionStore(path.join(root, 'sessions'));
}

function req(command: string, flags: DaemonRequest['flags'] = {}): DaemonRequest {
  return { token: 't', session: 'default', command, positionals: [], flags };
}

function waitAbsentReq(): DaemonRequest {
  return {
    ...req('wait'),
    positionals: ['absent', 'label="Removed"', '5000'],
  };
}

/** A request as the replay runtime dispatches it: authored provenance stamped on `internal`. */
function planStepReq(command: string, flags: DaemonRequest['flags'] = {}): DaemonRequest {
  return { ...req(command, flags), internal: { replayPlanStep: true } };
}

test('a repair-armed session excludes get/is/find by default but keeps recording wait', () => {
  const store = makeStore();
  const session = makeIosSession('default', {
    scriptPublication: {
      kind: 'repair',
      status: 'armed',
      target: { kind: 'default', force: false },
      boundary: 0,
    },
  });
  store.publish('default', session);

  recordIfSession(store, store.lookup('default'), req('get'), {});
  recordIfSession(store, store.lookup('default'), req('is'), {});
  recordIfSession(store, store.lookup('default'), req('find'), {});
  recordIfSession(store, store.lookup('default'), req('wait'), {});

  expect(store.get('default')!.actions.map((a) => a.command)).toEqual(['wait']);
});

// The P1 the command-class rule got wrong: an AUTHORED get/is/find plan step is
// the same command as an interactive diagnostic read, but it must survive into
// its own healed script — otherwise a repaired flow silently stops asserting
// what it used to assert, and users would have to annotate their own .ad steps
// with --record to keep them.
test('a repair-armed session still records get/is/find dispatched as replay plan steps (authored provenance)', () => {
  const store = makeStore();
  const session = makeIosSession('default', {
    scriptPublication: {
      kind: 'repair',
      status: 'armed',
      target: { kind: 'default', force: false },
      boundary: 0,
    },
  });
  store.publish('default', session);

  recordIfSession(store, store.lookup('default'), planStepReq('get'), {});
  recordIfSession(store, store.lookup('default'), planStepReq('is'), {});
  recordIfSession(store, store.lookup('default'), planStepReq('find'), {});

  expect(store.get('default')!.actions.map((a) => a.command)).toEqual(['get', 'is', 'find']);
});

test('--record forces get/is/find through even while repair-armed', () => {
  const store = makeStore();
  const session = makeIosSession('default', {
    scriptPublication: {
      kind: 'repair',
      status: 'armed',
      target: { kind: 'default', force: false },
      boundary: 0,
    },
  });
  store.publish('default', session);

  recordIfSession(store, store.lookup('default'), req('get', { record: true }), {});
  recordIfSession(store, store.lookup('default'), req('is', { record: true }), {});
  recordIfSession(store, store.lookup('default'), req('find', { record: true }), {});

  expect(store.get('default')!.actions.map((a) => a.command)).toEqual(['get', 'is', 'find']);
});

test('outside a repair-armed session, get/is/find/wait all record normally', () => {
  const store = makeStore();
  const session = makeIosSession('default');
  expect(session.scriptPublication).toBeUndefined();
  store.publish('default', session);

  recordIfSession(store, store.lookup('default'), req('get'), {});
  recordIfSession(store, store.lookup('default'), req('is'), {});
  recordIfSession(store, store.lookup('default'), req('find'), {});
  recordIfSession(store, store.lookup('default'), req('wait'), {});

  expect(store.get('default')!.actions.map((a) => a.command)).toEqual([
    'get',
    'is',
    'find',
    'wait',
  ]);
});

test('wait absent records positionals without target-v1 annotation', () => {
  const store = makeStore();
  store.publish('default', makeIosSession('default'));

  recordIfSession(store, store.lookup('default'), waitAbsentReq(), { waitedMs: 0 });

  expect(store.get('default')!.actions[0]).toMatchObject({
    command: 'wait',
    positionals: ['absent', 'label="Removed"', '5000'],
    result: { waitedMs: 0 },
  });
  expect(store.get('default')!.actions[0]?.targetEvidence).toBeUndefined();
});

test('sessionless recording cannot acquire a newly published address', () => {
  const store = makeStore();
  const admitted = store.lookup('default');
  const session = makeIosSession('default');
  store.publish('default', session);
  recordIfSession(store, admitted, req('wait'), { waitedMs: 100 });
  expect(session.actions).toEqual([]);
});

test('optional recording cannot adopt a successor lifetime', () => {
  const store = makeStore();
  const retired = store.publish('default', makeIosSession('default'));
  store.retire(retired);
  const successor = store.publish('default', makeIosSession('default'));
  expect(() => recordIfSession(store, retired, req('wait'), { completed: true })).not.toThrow();
  expect(store.requireCurrent(successor).actions).toEqual([]);
});
