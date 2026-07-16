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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordIfSession } from '../selector-recording.ts';
import { SessionStore } from '../session-store.ts';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import type { DaemonRequest } from '../types.ts';

function makeStore(): SessionStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-selector-recording-'));
  return new SessionStore(path.join(root, 'sessions'));
}

function req(command: string, flags: DaemonRequest['flags'] = {}): DaemonRequest {
  return { token: 't', session: 'default', command, positionals: [], flags };
}

/** A request as the replay runtime dispatches it: authored provenance stamped on `internal`. */
function planStepReq(command: string, flags: DaemonRequest['flags'] = {}): DaemonRequest {
  return { ...req(command, flags), internal: { replayPlanStep: true } };
}

test('a repair-armed session excludes get/is/find by default but keeps recording wait', () => {
  const store = makeStore();
  const session = makeIosSession('default', { saveScriptBoundary: 0 });
  store.set('default', session);

  recordIfSession(store, 'default', req('get'), {});
  recordIfSession(store, 'default', req('is'), {});
  recordIfSession(store, 'default', req('find'), {});
  recordIfSession(store, 'default', req('wait'), {});

  expect(store.get('default')!.actions.map((a) => a.command)).toEqual(['wait']);
});

// The P1 the command-class rule got wrong: an AUTHORED get/is/find plan step is
// the same command as an interactive diagnostic read, but it must survive into
// its own healed script — otherwise a repaired flow silently stops asserting
// what it used to assert, and users would have to annotate their own .ad steps
// with --record to keep them.
test('a repair-armed session still records get/is/find dispatched as replay plan steps (authored provenance)', () => {
  const store = makeStore();
  const session = makeIosSession('default', { saveScriptBoundary: 0 });
  store.set('default', session);

  recordIfSession(store, 'default', planStepReq('get'), {});
  recordIfSession(store, 'default', planStepReq('is'), {});
  recordIfSession(store, 'default', planStepReq('find'), {});

  expect(store.get('default')!.actions.map((a) => a.command)).toEqual(['get', 'is', 'find']);
});

test('--record forces get/is/find through even while repair-armed', () => {
  const store = makeStore();
  const session = makeIosSession('default', { saveScriptBoundary: 0 });
  store.set('default', session);

  recordIfSession(store, 'default', req('get', { record: true }), {});
  recordIfSession(store, 'default', req('is', { record: true }), {});
  recordIfSession(store, 'default', req('find', { record: true }), {});

  expect(store.get('default')!.actions.map((a) => a.command)).toEqual(['get', 'is', 'find']);
});

test('outside a repair-armed session, get/is/find/wait all record normally', () => {
  const store = makeStore();
  const session = makeIosSession('default');
  expect(session.saveScriptBoundary).toBeUndefined();
  store.set('default', session);

  recordIfSession(store, 'default', req('get'), {});
  recordIfSession(store, 'default', req('is'), {});
  recordIfSession(store, 'default', req('find'), {});
  recordIfSession(store, 'default', req('wait'), {});

  expect(store.get('default')!.actions.map((a) => a.command)).toEqual([
    'get',
    'is',
    'find',
    'wait',
  ]);
});
