import assert from 'node:assert/strict';
import { test } from 'vitest';
import { publishOpenSession } from '../session-open-state.ts';
import { makeSessionStore } from './session-open-runtime.fixtures.ts';
import {
  authoringPublication,
  makeIosSession,
} from '../../../../__tests__/support/session-factories.ts';
import { IOS_SIMULATOR } from '@agent-device/test-kit';
import { isSessionRecording } from '../../../../core/session-script-publication-capability.ts';

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

// --- #4162: the boot-ownership fact belongs to the open that published it ---
//
// Only a first open whose selection reported the boot records it. A re-open never adds or drops it,
// so the session that found the device stopped still owes it a stop after any number of re-opens.

function firstOpen(bootedByOpen: boolean | undefined) {
  const store = makeSessionStore();
  return store.requireCurrent(
    publishOpenSession({
      req: { token: 't', command: 'open', positionals: [], session: 's' },
      sessionStore: store,
      sessionName: 's',
      device: IOS_SIMULATOR,
      surface: 'app',
      bootedByOpen,
    }),
  );
}

test('#4162: an open whose selection reported the boot records it on the new session', () => {
  assert.equal(firstOpen(true).bootedByOpen, true);
});

test.each([false, undefined] as const)(
  '#4162: an open whose selection reported no boot records nothing',
  (bootedByOpen) => {
    assert.equal(firstOpen(bootedByOpen).bootedByOpen, undefined);
  },
);

const bootOwnershipFacts: readonly (true | undefined)[] = [true, undefined];

test.each(bootOwnershipFacts)(
  '#4162: a re-open leaves the boot ownership unchanged',
  (bootedByOpen) => {
    const store = makeSessionStore();
    const existing = makeIosSession('s', bootedByOpen === undefined ? {} : { bootedByOpen });
    const ref = store.publish(existing.name, existing);

    const next = store.requireCurrent(
      publishOpenSession({
        req: { token: 't', command: 'open', positionals: [], session: existing.name },
        sessionStore: store,
        sessionName: existing.name,
        existingRef: ref,
        device: IOS_SIMULATOR,
        surface: 'app',
        bootedByOpen: true,
      }),
    );

    assert.equal(next.bootedByOpen, bootedByOpen);
  },
);
