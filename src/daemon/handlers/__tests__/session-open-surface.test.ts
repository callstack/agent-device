import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  buildNextOpenSession,
  buildOpenResult,
  resolveRequestedOpenSurface,
} from '../session-open-surface.ts';
import {
  authoringPublication,
  makeIosSession,
} from '../../../__tests__/test-utils/session-factories.ts';
import { IOS_SIMULATOR } from '../../../__tests__/test-utils/device-fixtures.ts';

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

// --- #1533: `--save-script` arms recording through the publication lifecycle, not around it ---
//
// A re-open is the surface that used to set `recordSession` on its own. An ABORTED authoring
// lifecycle is terminal, so the flag must arm nothing here either — otherwise the session keeps
// paying recording-time costs (the direct-selector fast paths stay disabled) for a recording that
// can never publish, and the writer is the only thing standing between it and a stray script.

function reopen(existingSession: ReturnType<typeof makeIosSession>, saveScript: boolean) {
  return buildNextOpenSession({
    existingSession,
    sessionName: existingSession.name,
    device: IOS_SIMULATOR,
    surface: 'app',
    appBundleId: 'com.example.other',
    saveScript,
  });
}

test('#1533: re-opening an aborted authoring session with --save-script does not re-arm recording', () => {
  const aborted = makeIosSession('s', {
    recordSession: false,
    scriptPublication: authoringPublication('aborted'),
  });

  assert.equal(reopen(aborted, true).recordSession, false);
});

test('#1533: an aborted lifecycle that is already recording is corrected, not carried forward', () => {
  const drifted = makeIosSession('s', {
    recordSession: true,
    scriptPublication: authoringPublication('aborted'),
  });

  assert.equal(reopen(drifted, true).recordSession, false);
});

test('a re-open with --save-script still arms recording for a session with no publication yet', () => {
  const plain = makeIosSession('s', { recordSession: false });

  assert.equal(reopen(plain, true).recordSession, true);
});

test('a re-open without --save-script leaves an armed authoring session recording', () => {
  const armed = makeIosSession('s', {
    recordSession: true,
    scriptPublication: authoringPublication('armed'),
  });

  assert.equal(reopen(armed, false).recordSession, true);
});
