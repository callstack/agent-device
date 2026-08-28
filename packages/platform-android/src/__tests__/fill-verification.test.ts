// Fill reads the live hierarchy four times per attempt (one pre-action target read plus the
// 0/150/350 ms settling samples). Android permits ONE UiAutomation owner, so a command-scoped
// capture stops the automation-helper session after every one of those reads and the next read
// pays a fresh `am instrument` start. These tests pin who owns the helper session across the
// samples — not what the samples conclude, which fill-diagnostics/input-actions-fill own.

import { afterEach, beforeEach, test } from 'vitest';
import './test-utils/android-host-test-setup.ts';
import assert from 'node:assert/strict';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { withAndroidAdbProvider, type AndroidAdbProvider } from '../adb-executor.ts';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from './test-utils/android-snapshot-helper.ts';
import {
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
  assert.equal(session.captureCount(), 3);
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

  assert.equal(session.captureCount(), 3);
  assert.equal(session.spawnArgs.length, 3, 'each sample pays its own instrumentation start');
  assert.equal(session.forwardRemovals(), 3);
});

test('verification samples re-read the hierarchy instead of sharing one capture', async () => {
  // The 0/150/350 ms samples exist to observe settling. Sharing the session must not turn into
  // sharing its capture: replaying the first sample's still-settling text would report a mismatch
  // for a field that did take the value.
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

  assert.equal(session.captureCount(), 3);
  assert.equal(verification.actual, 'chips', 'the last sample is read from its own capture');
  assert.equal(verification.ok, true);
});

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
  assert.equal(session.captureCount(), 4);
  assert.equal(session.spawnArgs.length, 1);
  assert.equal(session.forwardRemovals(), 0);
});

type FillHelperSession = {
  provider: AndroidAdbProvider;
  spawnArgs: string[][];
  processes: FakeAndroidProcess[];
  captureCount: () => number;
  forwardRemovals: () => number;
};

function createFillHelperSession(
  options: { textForCapture?: (captureIndex: number) => string } = {},
): FillHelperSession {
  const calls: string[][] = [];
  const spawnArgs: string[][] = [];
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
