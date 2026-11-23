import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import {
  AppError,
  createRequestCanceledError,
  isRequestCanceledError,
} from '@agent-device/kernel/errors';
import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import {
  makeAndroidSession,
  makeIosSession,
} from '../../../__tests__/support/session-factories.ts';
import { detectAndroidEscapeSurface } from '../../android-foreground-surface.ts';
import {
  assertAndroidPressStayedInApp,
  ESCAPE_GUARD_SETTLE_MS,
} from './interaction-android-escape.ts';

// #5034: the guard read used to run immediately after the tap dispatch. A press that opens another
// app flips the focused window only once the app transition lands, so the immediate read named the
// old package and passed on stale state. The guard now asks the surface read to settle first.

afterEach(() => {
  vi.useRealTimers();
});

type RecordingObservation = {
  observation: AndroidObservationAdapter;
  focusReadsAt: number[];
  stateReadsAt: number[];
};

function recordingObservation(overrides?: {
  appOwnsFocus?: boolean;
  foregroundPackage?: string;
  permissionPackage?: boolean;
}): RecordingObservation {
  const reads: Pick<RecordingObservation, 'focusReadsAt' | 'stateReadsAt'> = {
    focusReadsAt: [],
    stateReadsAt: [],
  };
  const observation = {
    readAppFocus: async () => {
      reads.focusReadsAt.push(Date.now());
      return overrides?.appOwnsFocus ?? false;
    },
    readAppState: async () => {
      reads.stateReadsAt.push(Date.now());
      return { package: overrides?.foregroundPackage ?? 'com.android.settings' };
    },
    isPermissionPackage: async () => overrides?.permissionPackage ?? false,
  } as unknown as AndroidObservationAdapter;
  return { observation, ...reads };
}

const ESCAPE_SESSION = () =>
  makeAndroidSession('escape-settle-android', { appBundleId: 'com.example.app' });

test('the guard waits for the settle timer before its first foreground read', async () => {
  vi.useFakeTimers();
  const { observation, focusReadsAt } = recordingObservation();
  const pending = assertAndroidPressStayedInApp(
    ESCAPE_SESSION(),
    {
      command: 'press',
      targetLabel: '@e25',
    },
    observation,
  );

  await vi.advanceTimersByTimeAsync(0);
  assert.equal(vi.getTimerCount(), 1, 'the settle timer must be pending before the read');
  assert.equal(focusReadsAt.length, 0, 'no foreground read before the settle elapses');

  await vi.advanceTimersByTimeAsync(ESCAPE_GUARD_SETTLE_MS - 1);
  assert.equal(focusReadsAt.length, 0);

  await assert.rejects(
    () => Promise.all([pending, vi.advanceTimersByTimeAsync(1)]),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.expectedPackage, 'com.example.app');
      assert.equal(error.details?.foregroundPackage, 'com.android.settings');
      return true;
    },
  );
  assert.equal(focusReadsAt.length, 1);
  const firstEscapeReadAt = focusReadsAt[0];
  assert.ok(firstEscapeReadAt !== undefined && firstEscapeReadAt >= ESCAPE_GUARD_SETTLE_MS);
});

test('a clean press still passes after settling on an app-owned focus', async () => {
  vi.useFakeTimers();
  const { observation, focusReadsAt, stateReadsAt } = recordingObservation({ appOwnsFocus: true });
  const pending = assertAndroidPressStayedInApp(
    ESCAPE_SESSION(),
    {
      command: 'press',
      targetLabel: '@e1',
    },
    observation,
  );

  await vi.advanceTimersByTimeAsync(ESCAPE_GUARD_SETTLE_MS);
  assert.equal(await pending, undefined);
  assert.equal(focusReadsAt.length, 1);
  assert.equal(stateReadsAt.length, 0, 'an app-owned focus reads no foreground state');
});

test('a request deadline firing during the settle interrupts the guard instead of holding the step', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const { observation, focusReadsAt } = recordingObservation();
  const pending = assertAndroidPressStayedInApp(
    ESCAPE_SESSION(),
    {
      command: 'press',
      targetLabel: '@e1',
    },
    observation,
    {
      signal: controller.signal,
      deadlineAtMs: Date.now() + ESCAPE_GUARD_SETTLE_MS + 100,
    },
  );

  await vi.advanceTimersByTimeAsync(0);
  assert.equal(vi.getTimerCount(), 1, 'the settle timer is pending within the deadline');
  controller.abort(createRequestCanceledError());
  await assert.rejects(
    () => pending,
    (error: unknown) => {
      assert.equal(isRequestCanceledError(error), true);
      return true;
    },
  );
  assert.equal(vi.getTimerCount(), 0, 'the interrupted settle cleared its timer');
  assert.equal(focusReadsAt.length, 0, 'a canceled request reads no foreground');
});

test('a foregrounded permission dialog still warns instead of failing, after the settle', async () => {
  vi.useFakeTimers();
  const { observation, focusReadsAt, stateReadsAt } = recordingObservation({
    foregroundPackage: 'com.google.android.permissioncontroller',
    permissionPackage: true,
  });
  const pending = assertAndroidPressStayedInApp(
    ESCAPE_SESSION(),
    {
      command: 'press',
      targetLabel: '@e1',
    },
    observation,
  );

  await vi.advanceTimersByTimeAsync(ESCAPE_GUARD_SETTLE_MS);
  const warning = await pending;
  assert.match(warning ?? '', /permission dialog/);
  const firstWarningReadAt = focusReadsAt[0];
  assert.ok(firstWarningReadAt !== undefined && firstWarningReadAt >= ESCAPE_GUARD_SETTLE_MS);
  assert.equal(stateReadsAt.length, 1);
});

test('a press dispatched from an escape surface skips the guard and pays no wait', async () => {
  vi.useFakeTimers();
  const { observation, focusReadsAt, stateReadsAt } = recordingObservation();
  const pending = assertAndroidPressStayedInApp(
    ESCAPE_SESSION(),
    { command: 'press', targetLabel: '@e1', focusedPackageBefore: 'com.android.launcher3' },
    observation,
  );

  await vi.advanceTimersByTimeAsync(0);
  assert.equal(await pending, undefined);
  assert.equal(vi.getTimerCount(), 0, 'the skipped guard schedules no settle timer');
  assert.equal(focusReadsAt.length, 0);
  assert.equal(stateReadsAt.length, 0);
});

test('error-path annotation reads the foreground immediately and schedules no settle timer', async () => {
  vi.useFakeTimers();
  const clockStart = Date.now();
  const { observation, focusReadsAt } = recordingObservation({ appOwnsFocus: true });
  const pending = detectAndroidEscapeSurface(ESCAPE_SESSION(), observation);

  await vi.advanceTimersByTimeAsync(0);
  assert.equal(vi.getTimerCount(), 0, 'no settle option means no settle timer');
  assert.equal(await pending, null);
  assert.equal(focusReadsAt.length, 1);
  const firstAnnotationReadAt = focusReadsAt[0];
  assert.ok(firstAnnotationReadAt !== undefined);
  assert.equal(firstAnnotationReadAt - clockStart, 0, 'the annotation read waits for no settle');
});

test('a non-Android session pays no settle wait and reads nothing', async () => {
  vi.useFakeTimers();
  const { observation, focusReadsAt } = recordingObservation();
  const iosSession = makeIosSession('escape-settle-ios', { appBundleId: 'com.example.app' });
  const pending = detectAndroidEscapeSurface(iosSession, observation);

  await vi.advanceTimersByTimeAsync(0);
  assert.equal(vi.getTimerCount(), 0);
  assert.equal(await pending, null);
  assert.equal(focusReadsAt.length, 0);
});
