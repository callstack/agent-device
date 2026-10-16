// Fill reads the live hierarchy at least three times per attempt: one pre-action target read plus
// the settling samples, every 150 ms until the text has held for two of them or the deadline has
// passed. `am instrument` force-stops whatever is already instrumenting the helper package, so a
// command-scoped capture stops the automation-helper session after every one of those reads and the
// next read pays a fresh `am instrument` start. These tests pin who owns the helper session across
// the samples and what they conclude when the text lands late or never — not what one sample
// concludes, which fill-diagnostics/input-actions-fill own. The one conclusion pinned here is
// whether any of a commit reached the field, which both the soft-success guard and the IME rebind
// share.

import { afterEach, beforeEach, test, vi } from 'vitest';
import './test-utils/android-host-test-setup.ts';
import assert from 'node:assert/strict';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { withAndroidAdbProvider, type AndroidAdbProvider } from '../adb-executor.ts';
import type { AndroidFillVerificationNode } from '../fill-diagnostics.ts';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from './test-utils/android-snapshot-helper.ts';
import {
  isAndroidFillCommitDropped,
  readAndroidFillTargetBeforeMutation,
  verifyAndroidFilledText,
} from '../fill-verification.ts';
import { resetAndroidSnapshotHelperSessions } from '../snapshot-helper-session-lifecycle.ts';
import {
  createPersistentSnapshotHelperProvider,
  isAndroidHelperForwardRemoval,
  type FakeAndroidProcess,
} from './snapshot-helper-session.fixtures.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

beforeEach(async () => {
  await resetAndroidSnapshotHelperSessions();
});

afterEach(async () => {
  await resetAndroidSnapshotHelperSessions();
});

test('daemon-session verification samples reuse one warm helper session', async () => {
  const session = createFillHelperSession();

  const verification = await withFillHelperProvider(
    session.provider,
    async () =>
      await verifyAndroidFilledText(device, 10, 10, 'chips', {
        helperSessionScope: 'daemon-session',
      }),
  );

  assert.equal(verification.ok, true);
  assert.equal(session.captureCount(), 2, 'the text held for two samples');
  assert.equal(session.spawnArgs.length, 1, 'one instrumentation start for every sample');
  assert.equal(session.processes[0]?.exitCode, null, 'the session must outlive the command');
  assert.equal(session.forwardRemovals(), 0);
});

test('command-scoped verification samples release the helper after every sample', async () => {
  const session = createFillHelperSession();

  await withFillHelperProvider(
    session.provider,
    async () => await verifyAndroidFilledText(device, 10, 10, 'chips'),
  );

  assert.equal(session.captureCount(), 2);
  assert.equal(session.spawnArgs.length, 2, 'each sample pays its own instrumentation start');
  assert.equal(session.forwardRemovals(), 2);
});

test('verification samples re-read the hierarchy instead of sharing one capture', async () => {
  // The samples exist to observe settling. Sharing the session must not turn into sharing its
  // capture: replaying the first sample's still-settling text would report a mismatch for a field
  // that did take the value.
  const settlingText = ['chi', 'chip', 'chips'];
  const session = createFillHelperSession({
    textForCapture: (captureIndex) => settlingText[captureIndex - 1] ?? 'chips',
  });

  const verification = await withFillHelperProvider(
    session.provider,
    async () =>
      await verifyAndroidFilledText(device, 10, 10, 'chips', {
        helperSessionScope: 'daemon-session',
      }),
  );

  assert.equal(session.captureCount(), 4, 'two settling samples, then the text held for two');
  assert.equal(verification.actual, 'chips', 'the last sample is read from its own capture');
  assert.equal(verification.ok, true);
});

test('a value the app renders late still verifies, as long as it lands before the deadline', async () => {
  // Six samples of the hint before the value shows, 900 ms in and inside the deadline.
  const session = createFillHelperSession({
    textForCapture: (captureIndex) => (captureIndex <= 6 ? 'Key echo' : 'chips'),
  });

  const verification = await underFakeTimers(
    async () =>
      await withFillHelperProvider(
        session.provider,
        async () =>
          await verifyAndroidFilledText(device, 10, 10, 'chips', {
            helperSessionScope: 'daemon-session',
          }),
      ),
  );

  assert.equal(verification.ok, true);
  assert.equal(session.captureCount(), 8, 'six hint samples, then the value held for two');
});

test('a value that never lands is a mismatch read from the last sample', async () => {
  const session = createFillHelperSession({ textForCapture: () => 'Key echo' });
  let elapsedMs = 0;

  const verification = await underFakeTimers(async () => {
    const startedAt = Date.now();
    const result = await withFillHelperProvider(
      session.provider,
      async () =>
        await verifyAndroidFilledText(device, 10, 10, 'chips', {
          helperSessionScope: 'daemon-session',
        }),
    );
    elapsedMs = Date.now() - startedAt;
    return result;
  });

  assert.equal(verification.ok, false);
  assert.equal(verification.reason, 'text_mismatch');
  assert.equal(verification.actual, 'Key echo');
  assert.ok(
    elapsedMs >= 1_500 && elapsedMs < 1_650,
    `sampled until the deadline, took ${elapsedMs} ms`,
  );
  assert.ok(session.captureCount() >= 9, 'kept sampling on its interval');
});

/**
 * Runs the sampler with its sleeps advanced instead of waited out. The clock moves in slices
 * shorter than a sample interval so the helper session's own timers never fire ahead of its replies.
 */
async function underFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    let done = false;
    const outcome = run().finally(() => {
      done = true;
    });
    outcome.catch(() => {});
    while (!done) await vi.advanceTimersByTimeAsync(10);
    return await outcome;
  } finally {
    vi.useRealTimers();
  }
}

test('the pre-action target read shares the daemon-session helper with the samples', async () => {
  const session = createFillHelperSession();

  const target = await withFillHelperProvider(session.provider, async () => {
    const before = await readAndroidFillTargetBeforeMutation(device, 10, 10, {
      helperSessionScope: 'daemon-session',
    });
    await verifyAndroidFilledText(device, 10, 10, 'chips', {
      helperSessionScope: 'daemon-session',
    });
    return before;
  });

  assert.equal(target?.resourceId, 'com.example:id/field');
  assert.equal(session.captureCount(), 3);
  assert.equal(session.spawnArgs.length, 1);
  assert.equal(session.forwardRemovals(), 0);
});

type FillHelperSession = {
  provider: AndroidAdbProvider;
  spawnArgs: (readonly string[])[];
  processes: FakeAndroidProcess[];
  captureCount: () => number;
  forwardRemovals: () => number;
};

function createFillHelperSession(
  options: { textForCapture?: (captureIndex: number) => string } = {},
): FillHelperSession {
  const calls: (readonly string[])[] = [];
  const spawnArgs: (readonly string[])[] = [];
  const processes: FakeAndroidProcess[] = [];
  let captureCount = 0;
  const provider = createPersistentSnapshotHelperProvider({
    calls,
    spawnArgs,
    processes,
    sessionXml: () => {
      captureCount += 1;
      return filledFieldXml(options.textForCapture?.(captureCount) ?? 'chips');
    },
  });
  return {
    provider: { ...provider, exec: withKeyboardStateProbe(provider.exec) },
    spawnArgs,
    processes,
    captureCount: () => captureCount,
    forwardRemovals: () => calls.filter(isAndroidHelperForwardRemoval).length,
  };
}

async function withFillHelperProvider<T>(
  provider: AndroidAdbProvider,
  fn: () => Promise<T>,
): Promise<T> {
  return await withAndroidAdbProvider(
    { ...provider, snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT },
    { serial: device.id },
    fn,
  );
}

function withKeyboardStateProbe(exec: AndroidAdbProvider['exec']): AndroidAdbProvider['exec'] {
  return async (args, execOptions) => {
    if (args.join(' ') === 'shell dumpsys input_method') {
      return { exitCode: 0, stdout: 'mCurMethodId=com.example.ime/.Ime', stderr: '' };
    }
    return await exec(args, execOptions);
  };
}

function filledFieldXml(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><hierarchy><node package="com.example" class="android.widget.EditText" text="${text}" resource-id="com.example:id/field" focused="true" bounds="[0,0][200,100]"/></hierarchy>`;
}

function fillNode(text: string | null, hintShowing = false): AndroidFillVerificationNode {
  return {
    text,
    className: 'android.widget.EditText',
    resourceId: null,
    packageName: 'com.example',
    rect: { x: 0, y: 0, width: 200, height: 100 },
    focused: true,
    password: false,
    inputMethodOwned: false,
    area: 20_000,
    hintShowing,
    placeholder: null,
  };
}

test('a commit counts as dropped when the field shows its hint or keeps its old value', () => {
  const before = fillNode('Old');
  const observed = (text: string | null, hintShowing = false) => ({
    ok: false,
    actual: text,
    targetInput: fillNode(text, hintShowing),
    actualInput: fillNode(text, hintShowing),
  });

  assert.equal(isAndroidFillCommitDropped(observed('e.g. Jane', true), before), true);
  assert.equal(isAndroidFillCommitDropped(observed('Old'), before), true);
  assert.equal(isAndroidFillCommitDropped(observed(null), before), true);
  assert.equal(
    isAndroidFillCommitDropped(
      { ok: false, actual: null, actualInput: null, targetInput: null },
      before,
    ),
    false,
  );
  assert.equal(isAndroidFillCommitDropped(observed('Jan'), before), false);
  assert.equal(isAndroidFillCommitDropped(observed('Jan'), null), false);
});
