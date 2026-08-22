import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeAndroidSession } from '../../__tests__/test-utils/session-factories.ts';
import { withFakeAdb } from '../../__tests__/test-utils/fake-adb.ts';
import { expireRefFrame } from '../ref-frame.ts';
import { ensureAndroidBlockingSystemDialogReady } from '../android-system-dialog.ts';
import { ANDROID_DIALOG_READINESS_OBSERVATION_TTL_MS } from '../android-dialog-readiness-observation.ts';

// The pre-dispatch check of one command repeats the post-dispatch check of the previous one. These
// pin which of those repeats may be answered from the recorded observation, and which may not.

const NORMAL_FOCUS_DUMP =
  '  mCurrentFocus=Window{a1b2c3 u0 com.agentdevice.tester/com.agentdevice.tester.MainActivity}';
const ANR_FOCUS_DUMP =
  '  mCurrentFocus=Window{ffeedd u0 Application Not Responding: com.agentdevice.tester}';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function withDialogDumps<T>(
  dump: () => string,
  run: (ctx: { windowDumps: () => number }) => Promise<T>,
): Promise<T> {
  return await withFakeAdb(
    (args) => (args[1] === 'dumpsys' ? dump() : ''),
    async ({ calls }) =>
      await run({ windowDumps: () => calls.filter((args) => args[1] === 'dumpsys').length }),
  );
}

test('a post-dispatch check always re-observes the device', async () => {
  const session = makeAndroidSession('readiness-after');
  await withDialogDumps(
    () => NORMAL_FOCUS_DUMP,
    async ({ windowDumps }) => {
      await ensureAndroidBlockingSystemDialogReady({
        session,
        command: 'tap',
        phase: 'before-command',
      });
      expireRefFrame(session);
      await ensureAndroidBlockingSystemDialogReady({
        session,
        command: 'tap',
        phase: 'after-command',
      });
      expect(windowDumps()).toBe(2);
    },
  );
});

test('the next pre-dispatch check reuses the post-dispatch observation', async () => {
  const session = makeAndroidSession('readiness-reuse');
  await withDialogDumps(
    () => NORMAL_FOCUS_DUMP,
    async ({ windowDumps }) => {
      expireRefFrame(session);
      await ensureAndroidBlockingSystemDialogReady({
        session,
        command: 'tap',
        phase: 'after-command',
      });
      expect(windowDumps()).toBe(1);

      const readiness = await ensureAndroidBlockingSystemDialogReady({
        session,
        command: 'tap',
        phase: 'before-command',
      });
      expect(readiness).toEqual({ status: 'clear' });
      expect(windowDumps()).toBe(1);
    },
  );
});

test('any device side effect invalidates the observation', async () => {
  const session = makeAndroidSession('readiness-side-effect');
  await withDialogDumps(
    () => NORMAL_FOCUS_DUMP,
    async ({ windowDumps }) => {
      await ensureAndroidBlockingSystemDialogReady({
        session,
        command: 'tap',
        phase: 'after-command',
      });
      expireRefFrame(session);
      await ensureAndroidBlockingSystemDialogReady({
        session,
        command: 'tap',
        phase: 'before-command',
      });
      expect(windowDumps()).toBe(2);
    },
  );
});

test('the observation ages out even when nothing mutated the device', async () => {
  const session = makeAndroidSession('readiness-ttl');
  await withDialogDumps(
    () => NORMAL_FOCUS_DUMP,
    async ({ windowDumps }) => {
      await ensureAndroidBlockingSystemDialogReady({
        session,
        command: 'tap',
        phase: 'after-command',
      });
      vi.advanceTimersByTime(ANDROID_DIALOG_READINESS_OBSERVATION_TTL_MS);
      await ensureAndroidBlockingSystemDialogReady({
        session,
        command: 'tap',
        phase: 'before-command',
      });
      expect(windowDumps()).toBe(2);
    },
  );
});

test('a blocking dialog is never recorded as a clear observation', async () => {
  const session = makeAndroidSession('readiness-dialog');
  session.appBundleId = undefined;
  await withDialogDumps(
    () => ANR_FOCUS_DUMP,
    async ({ windowDumps }) => {
      await expect(
        ensureAndroidBlockingSystemDialogReady({
          session,
          command: 'tap',
          phase: 'after-command',
        }),
      ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
      await expect(
        ensureAndroidBlockingSystemDialogReady({
          session,
          command: 'tap',
          phase: 'before-command',
        }),
      ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
      expect(windowDumps()).toBe(2);
    },
  );
});
