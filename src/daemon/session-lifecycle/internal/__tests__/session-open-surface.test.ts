import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { buildOpenResult } from '../session-open-surface.ts';
import { resolveRequestedOpenSurface } from '../../../../platform-runtime-open-target.ts';
import { IOS_SIMULATOR } from '../../../../__tests__/test-utils/device-fixtures.ts';

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

test('buildOpenResult reports an answered launch confirmation and omits one that never appeared', () => {
  const base = {
    sessionName: 'ios-launch-url',
    sessionStateDir: '/tmp/state',
    runnerLogPath: '/tmp/runner.log',
    requestLogPath: '/tmp/request.ndjson',
    eventLogPath: '/tmp/events.ndjson',
    surface: 'app' as const,
    device: IOS_SIMULATOR,
    runtimeHintCount: () => 0,
    sessionReused: false,
  };

  assert.equal(
    buildOpenResult({ ...base, launchConfirmation: 'accepted' }).launchConfirmation,
    'accepted',
  );
  assert.equal('launchConfirmation' in buildOpenResult(base), false);
});
