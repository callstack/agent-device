import assert from 'node:assert/strict';
import { test } from 'vitest';
import { publishOpenSession } from '../session-open-state.ts';
import { makeSessionStore } from './session-open-runtime.fixtures.ts';
import {
  authoringPublication,
  makeIosSession,
} from '../../../../__tests__/test-utils/session-factories.ts';
import { IOS_SIMULATOR } from '../../../../__tests__/test-utils/device-fixtures.ts';
import { isSessionRecording } from '../../../session-script-publication-capability.ts';

// --- #1533: a re-open cannot resurrect a terminal authoring lifecycle ---
//
// This surface used to decide recording on its own (`existingSession.recordSession || saveScript`),
// which is how an ABORTED lifecycle came back to life on a third `open --save-script`. Recording is
// now derived from the lifecycle, so the only thing left to pin here is that a re-open carries the
// publication state through untouched — it has no arming decision to get wrong.

function reopen(existingSession: ReturnType<typeof makeIosSession>) {
  const store = makeSessionStore();
  const ref = store.publish(existingSession.name, existingSession);
  return store.requireCurrent(
    publishOpenSession({
      req: { token: 't', command: 'open', positionals: [], session: existingSession.name },
      sessionStore: store,
      sessionName: existingSession.name,
      existingRef: ref,
      device: IOS_SIMULATOR,
      surface: 'app',
      appBundleId: 'com.example.other',
    }),
  );
}

test('#1533: a re-open leaves an aborted authoring lifecycle aborted, and not recording', () => {
  const aborted = makeIosSession('s', { scriptPublication: authoringPublication('aborted') });

  const next = reopen(aborted);

  assert.deepEqual(next.scriptPublication, authoringPublication('aborted'));
  assert.equal(isSessionRecording(next), false);
});

test('a re-open carries an armed authoring lifecycle through unchanged', () => {
  const armed = makeIosSession('s', { scriptPublication: authoringPublication('armed') });

  const next = reopen(armed);

  assert.deepEqual(next.scriptPublication, authoringPublication('armed'));
  assert.equal(isSessionRecording(next), true);
});

test('a re-open of a session that never armed records nothing', () => {
  const next = reopen(makeIosSession('s'));

  assert.equal(next.scriptPublication, undefined);
  assert.equal(isSessionRecording(next), false);
});
