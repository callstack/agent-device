import assert from 'node:assert/strict';
import { test } from 'vitest';
import { publishOpenSession } from '../session-open-state.ts';
import { makeSessionStore } from './session-open-runtime.fixtures.ts';
import { NO_BOOT_PROOF } from '../../../../__tests__/support/boot-ownership-fixtures.ts';
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
      bootOwnership: NO_BOOT_PROOF,
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
// Ownership survives reopens of the same target. A replacement owns only its own boot.

function firstOpen(bootedByOpen: boolean | undefined) {
  const store = makeSessionStore();
  return publishOpenSession({
    req: { token: 't', command: 'open', positionals: [], session: 's' },
    sessionStore: store,
    sessionName: 's',
    device: IOS_SIMULATOR,
    surface: 'app',
    bootOwnership: { ownsBoot: bootedByOpen === true, bootOwnerUnverified: false },
  }).session;
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

test.each([false, true])('replacement target owns only its own boot: %s', (replacementBooted) => {
  const store = makeSessionStore();
  const existing = makeIosSession('s', { bootedByOpen: true });
  const ref = store.publish(existing.name, existing);
  const next = store.requireCurrent(
    publishOpenSession({
      req: { token: 't', command: 'open', positionals: [], session: existing.name },
      sessionStore: store,
      sessionName: existing.name,
      existingRef: ref,
      device: { ...IOS_SIMULATOR, id: 'replacement-simulator' },
      surface: 'app',
      bootOwnership: { ownsBoot: replacementBooted, bootOwnerUnverified: false },
    }),
  );
  assert.equal(next.bootedByOpen, replacementBooted ? true : undefined);
});

test.each(bootOwnershipFacts)(
  '#4162: a re-open that reports a boot owns the device from then on',
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
        bootOwnership: { ownsBoot: true, bootOwnerUnverified: false },
      }),
    );

    assert.equal(next.bootedByOpen, true);
  },
);

test.each(bootOwnershipFacts)(
  '#4162: a re-open that reports no boot leaves the ownership unchanged',
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
        bootOwnership: NO_BOOT_PROOF,
      }),
    );

    assert.equal(next.bootedByOpen, bootedByOpen);
  },
);

test('#4791: an open the platform disproved records no boot and the reason close reports', () => {
  const store = makeSessionStore();
  const next = publishOpenSession({
    req: { token: 't', command: 'open', positionals: [], session: 's' },
    sessionStore: store,
    sessionName: 's',
    device: IOS_SIMULATOR,
    surface: 'app',
    bootOwnership: { ownsBoot: false, bootOwnerUnverified: true },
  }).session;

  assert.equal(next.bootedByOpen, undefined);
  assert.equal(next.bootOwnerUnverified, true);
});

test('#4791: a re-open of the same target clears the disproved boot with its own proof', () => {
  const store = makeSessionStore();
  const existing = makeIosSession('s', { bootOwnerUnverified: true });
  const ref = store.publish(existing.name, existing);

  const next = store.requireCurrent(
    publishOpenSession({
      req: { token: 't', command: 'open', positionals: [], session: existing.name },
      sessionStore: store,
      sessionName: existing.name,
      existingRef: ref,
      device: IOS_SIMULATOR,
      surface: 'app',
      bootOwnership: NO_BOOT_PROOF,
    }),
  );

  assert.equal(next.bootOwnerUnverified, undefined);
});

test('#4791: a disproved re-open cannot take back a boot an earlier open of the same device proved', () => {
  const store = makeSessionStore();
  const existing = makeIosSession('s', { bootedByOpen: true });
  const ref = store.publish(existing.name, existing);

  const next = store.requireCurrent(
    publishOpenSession({
      req: { token: 't', command: 'open', positionals: [], session: existing.name },
      sessionStore: store,
      sessionName: existing.name,
      existingRef: ref,
      device: IOS_SIMULATOR,
      surface: 'app',
      bootOwnership: { ownsBoot: false, bootOwnerUnverified: true },
    }),
  );

  // Close stops on the preserved proof, so it must not also report a stop it withheld.
  assert.equal(next.bootedByOpen, true);
  assert.equal(next.bootOwnerUnverified, undefined);
});
