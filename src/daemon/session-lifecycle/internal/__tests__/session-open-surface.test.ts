import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { buildNextOpenSession, buildOpenResult } from '../session-open-surface.ts';
import { resolveRequestedOpenSurface } from '../../../../platform-runtime-open-target.ts';
import {
  authoringPublication,
  makeIosSession,
} from '../../../../__tests__/test-utils/session-factories.ts';
import { IOS_SIMULATOR } from '../../../../__tests__/test-utils/device-fixtures.ts';
import { isSessionRecording } from '../../../session-script-publication-capability.ts';

test('resolveRequestedOpenSurface rejects surface flag on iOS', () => {
  assert.throws(
    () =>
      resolveRequestedOpenSurface({
        device: {
          platform: 'apple',
          id: 'sim-1',
          name: 'iPhone 17',
          kind: 'simulator',
        },
        surfaceFlag: 'desktop',
        openTarget: undefined,
      }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /surface is only supported on macOS/i.test(error.message),
  );
});

test('buildOpenResult exposes the Vega serial without leaking an internal platform alias', () => {
  const result = buildOpenResult({
    sessionName: 'vega-tv',
    sessionStateDir: '/tmp/state',
    runnerLogPath: '/tmp/runner.log',
    requestLogPath: '/tmp/request.ndjson',
    eventLogPath: '/tmp/events.ndjson',
    appName: 'com.example.app.main',
    surface: 'app',
    device: {
      platform: 'vega',
      id: 'amazon-vvd',
      name: 'Vega Virtual Device',
      kind: 'emulator',
      target: 'tv',
      booted: true,
    },
    runtimeHintCount: () => 0,
    sessionReused: false,
  });

  assert.equal(result.platform, 'vega');
  assert.equal(result.serial, 'amazon-vvd');
  assert.equal(result.target, 'tv');
});

test('buildOpenResult exposes typed device-selection evidence once at response level', () => {
  const result = buildOpenResult({
    sessionName: 'ios-selection',
    sessionStateDir: '/tmp/state',
    runnerLogPath: '/tmp/runner.log',
    requestLogPath: '/tmp/request.ndjson',
    eventLogPath: '/tmp/events.ndjson',
    surface: 'app',
    device: IOS_SIMULATOR,
    runtimeHintCount: () => 0,
    sessionReused: false,
    selection: {
      device: IOS_SIMULATOR,
      reason: 'single-booted-local',
      source: 'local',
      candidateCount: 1,
      bootOccurred: false,
    },
  });

  assert.deepEqual(result.selection, {
    reason: 'single-booted-local',
    source: 'local',
    candidateCount: 1,
    bootOccurred: false,
  });
});

// --- #1533: a re-open cannot resurrect a terminal authoring lifecycle ---
//
// This surface used to decide recording on its own (`existingSession.recordSession || saveScript`),
// which is how an ABORTED lifecycle came back to life on a third `open --save-script`. Recording is
// now derived from the lifecycle, so the only thing left to pin here is that a re-open carries the
// publication state through untouched — it has no arming decision to get wrong.

function reopen(existingSession: ReturnType<typeof makeIosSession>) {
  return buildNextOpenSession({
    existingSession,
    sessionName: existingSession.name,
    sessionScope: existingSession.sessionScope ?? { kind: 'named-local' },
    device: IOS_SIMULATOR,
    surface: 'app',
    appBundleId: 'com.example.other',
  });
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
