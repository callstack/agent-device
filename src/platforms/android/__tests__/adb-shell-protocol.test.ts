import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';
import {
  androidAdbForwardsDeviceExitStatus,
  resetAndroidAdbShellProtocolProbes,
} from '../adb-shell-protocol.ts';
import type { AndroidAdbExecutor } from '../adb-executor.ts';

beforeEach(() => {
  resetAndroidAdbShellProtocolProbes();
});

test('reads the negotiated feature set as proof that adb forwards device exit status', async () => {
  const calls: string[][] = [];
  const adb = featuresAdb(calls, {
    exitCode: 0,
    stdout: 'sendrecv_v2\nstat_v2\nshell_v2\ncmd\n',
    stderr: '',
  });

  assert.equal(
    await androidAdbForwardsDeviceExitStatus({ adb, deviceKey: 'android:emulator-5554' }),
    true,
  );
  assert.deepEqual(calls, [['features']]);
});

test('treats a transport without shell protocol v2 as unable to prove a device exit', async () => {
  const adb = featuresAdb([], { exitCode: 0, stdout: 'stat_v2\ncmd\n', stderr: '' });

  assert.equal(
    await androidAdbForwardsDeviceExitStatus({ adb, deviceKey: 'android:emulator-5554' }),
    false,
  );
});

test('treats an unanswered probe as unknown rather than caching it as unsupported', async () => {
  const calls: string[][] = [];
  let answered = false;
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    if (!answered) {
      answered = true;
      return { exitCode: 1, stdout: '', stderr: 'adb: unknown command features' };
    }
    return { exitCode: 0, stdout: 'shell_v2\n', stderr: '' };
  };

  assert.equal(
    await androidAdbForwardsDeviceExitStatus({ adb, deviceKey: 'android:emulator-5554' }),
    false,
  );
  // The failed probe proved nothing, so it is not remembered as an answer.
  assert.equal(
    await androidAdbForwardsDeviceExitStatus({ adb, deviceKey: 'android:emulator-5554' }),
    true,
  );
  assert.equal(calls.length, 2);
});

test('reports no proof when the probe itself throws', async () => {
  const adb: AndroidAdbExecutor = async () => {
    throw new Error('device offline');
  };

  assert.equal(
    await androidAdbForwardsDeviceExitStatus({ adb, deviceKey: 'android:emulator-5554' }),
    false,
  );
});

test('answers each device from its own negotiated feature set', async () => {
  const adb: AndroidAdbExecutor = async () => ({
    exitCode: 0,
    stdout: 'shell_v2\n',
    stderr: '',
  });
  const legacyAdb: AndroidAdbExecutor = async () => ({ exitCode: 0, stdout: 'cmd\n', stderr: '' });

  assert.equal(
    await androidAdbForwardsDeviceExitStatus({ adb, deviceKey: 'android:emulator-5554' }),
    true,
  );
  assert.equal(
    await androidAdbForwardsDeviceExitStatus({
      adb: legacyAdb,
      deviceKey: 'android:legacy-device',
    }),
    false,
  );
});

function featuresAdb(
  calls: string[][],
  result: { exitCode: number; stdout: string; stderr: string },
): AndroidAdbExecutor {
  return async (args) => {
    calls.push(args);
    return result;
  };
}
