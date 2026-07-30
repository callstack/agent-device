import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  AndroidAdbExecutor,
  AndroidAdbProvider,
} from '../../platforms/android/adb-executor.ts';
import type { LimrunAndroidSession } from './android.ts';
import { createLimrunDeviceSession, type LimrunIosCommandExecution } from './device-session.ts';
import type { LimrunIosSession } from './ios.ts';

const IOS_APPS = [
  { bundleId: 'com.apple.Preferences', name: 'Settings', installType: 'System' },
  { bundleId: 'com.example.ios', name: 'Example', installType: 'User' },
];

test('iOS device session exposes reusable capabilities without its raw client', async () => {
  const pressKey = vi.fn(async () => undefined);
  const readLogs = vi.fn(async () => 'line one\nline two\n');
  const startRecording = vi.fn(async () => undefined);
  const stopRecording = vi.fn(async () => 'https://ios.example/recording');
  const simctlWait = vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '' }));
  const simctl = vi.fn(() => commandExecution(simctlWait));
  const session = createLimrunDeviceSession(
    iosSession({
      deviceInfo: { screenWidth: 402, screenHeight: 874 },
      listApps: vi.fn(async () => IOS_APPS),
      pressKey,
      appLogTail: readLogs,
      startRecording,
      stopRecording,
      simctl,
    }),
  );

  assert.equal(session.platform, 'ios');
  if (session.platform !== 'ios') throw new Error('Expected an iOS device session');

  assert.deepEqual(await session.listApps(), [
    { id: 'com.example.ios', name: 'Example', installType: 'User' },
  ]);
  assert.deepEqual(await session.listApps('all'), [
    { id: 'com.apple.Preferences', name: 'Settings', installType: 'System' },
    { id: 'com.example.ios', name: 'Example', installType: 'User' },
  ]);
  assert.equal('getForegroundApp' in session, false);
  assert.deepEqual(session.viewport, { width: 402, height: 874 });
  await session.pressKey('enter', ['command']);
  assert.equal(await session.readLogs('com.example.ios', 200), 'line one\nline two\n');
  await session.startRecording({ quality: 8 });
  assert.equal(
    await session.stopRecording({ outPath: '/tmp/ios-recording.mp4' }),
    'https://ios.example/recording',
  );
  assert.deepEqual(await session.runSimctl(['listapps', 'booted']).wait(), {
    code: 0,
    stdout: 'ok',
    stderr: '',
  });

  assert.deepEqual(pressKey.mock.calls[0], ['enter', ['command']]);
  assert.deepEqual(readLogs.mock.calls[0], ['com.example.ios', 200]);
  assert.deepEqual(startRecording.mock.calls[0], [{ quality: 8 }]);
  assert.deepEqual(stopRecording.mock.calls[0], [{ localPath: '/tmp/ios-recording.mp4' }]);
  assert.deepEqual(simctl.mock.calls[0], [['listapps', 'booted']]);
  assert.equal('client' in session, false);
});

test('iOS remote install waits for eventually consistent app inventory', async () => {
  const staleApps = IOS_APPS.slice(0, 1);
  const installedApps = [...staleApps, IOS_APPS[1]];
  const listApps = vi
    .fn(async () => installedApps)
    .mockResolvedValueOnce(staleApps)
    .mockResolvedValueOnce(staleApps);
  const installApp = vi.fn(async () => ({ bundleId: 'com.example.ios' }));
  const session = createLimrunDeviceSession(
    iosSession({
      deviceInfo: { screenWidth: 402, screenHeight: 874 },
      listApps,
      installApp,
    }),
  );

  assert.equal(session.platform, 'ios');
  assert.deepEqual(
    await session.installRemoteApp('https://assets.example/example.zip', {
      md5: 'example-md5',
      relaunch: true,
      appIdentifierHint: 'com.example.ios',
    }),
    { appId: 'com.example.ios' },
  );
  assert.equal(listApps.mock.calls.length, 3);
  assert.deepEqual(installApp.mock.calls[0], [
    'https://assets.example/example.zip',
    { md5: 'example-md5', launchMode: 'RelaunchIfRunning' },
  ]);
});

test('Android device session exposes semantic ADB capabilities without its raw client', async () => {
  const adb = vi.fn(async (args: string[]) => {
    if (args.includes('query-activities')) return adbResult('com.example.android/.MainActivity\n');
    if (args.includes('packages')) return adbResult('package:com.example.android\n');
    if (args.includes('window')) {
      return adbResult('mCurrentFocus=Window{42 u0 com.example.android/.MainActivity}\n');
    }
    if (args.includes('input_method')) {
      return adbResult('mInputShown=false mCurMethodId=com.android.inputmethod.latin/.LatinIME');
    }
    if (args.includes('logcat')) return adbResult('log line\n');
    return adbResult('');
  }) as AndroidAdbExecutor;
  const removeReverse = vi.fn(async () => undefined);
  const provider: AndroidAdbProvider = {
    exec: adb,
    reverse: {
      ensure: vi.fn(async () => undefined),
      remove: removeReverse,
      removeAllOwned: vi.fn(async () => undefined),
    },
  };
  const pressKey = vi.fn(async () => undefined);
  const startRecording = vi.fn(async () => undefined);
  const stopRecording = vi.fn(async () => 'https://android.example/recording');
  const sendAsset = vi.fn(async () => undefined);
  const session = createLimrunDeviceSession(
    androidSession(provider, { pressKey, startRecording, stopRecording, sendAsset }),
  );

  assert.equal(session.platform, 'android');
  if (session.platform !== 'android') throw new Error('Expected an Android device session');

  assert.deepEqual(await session.listApps(), [{ id: 'com.example.android', name: 'Example' }]);
  assert.deepEqual(await session.getForegroundApp(), {
    appId: 'com.example.android',
    activity: '.MainActivity',
  });
  assert.equal((await session.getKeyboardState()).visible, false);
  assert.equal((await session.dismissKeyboard()).dismissed, false);
  assert.equal(await session.readLogs(20), 'log line\n');
  assert.equal(await session.installRemoteApp('https://assets.example/android.apk'), undefined);
  await session.pressKey('KEYCODE_ENTER', ['shift']);
  await session.startRecording({ quality: 7 });
  assert.equal(
    await session.stopRecording({ outPath: '/tmp/android-recording.mp4' }),
    'https://android.example/recording',
  );
  await session.adb.reverse?.remove('tcp:8081');

  assert.deepEqual(sendAsset.mock.calls[0], ['https://assets.example/android.apk']);
  assert.deepEqual(pressKey.mock.calls[0], ['KEYCODE_ENTER', ['shift']]);
  assert.deepEqual(startRecording.mock.calls[0], [{ quality: 7 }]);
  assert.deepEqual(stopRecording.mock.calls[0], [{ localPath: '/tmp/android-recording.mp4' }]);
  assert.deepEqual(removeReverse.mock.calls[0], ['tcp:8081']);
  assert.equal(session.adb, provider);
  assert.equal('client' in session, false);
});

function iosSession(client: Record<string, unknown>): LimrunIosSession {
  return {
    platform: 'ios',
    lease: lease('ios-instance'),
    instanceId: 'ios-instance',
    device: device('ios'),
    client,
  } as unknown as LimrunIosSession;
}

function androidSession(
  adbProvider: AndroidAdbProvider,
  client: Record<string, unknown>,
): LimrunAndroidSession {
  return {
    platform: 'android',
    lease: lease('android-instance'),
    instanceId: 'android-instance',
    device: device('android'),
    client,
    adbProvider,
  } as unknown as LimrunAndroidSession;
}

function lease(backend: 'ios-instance' | 'android-instance'): DeviceLease {
  return {
    leaseId: `lease-${backend}`,
    tenantId: 'team-a',
    runId: 'run-a',
    backend,
    leaseProvider: 'limrun',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: 60_001,
  };
}

function device(platform: 'ios' | 'android'): DeviceInfo {
  return {
    platform: platform === 'ios' ? 'apple' : 'android',
    ...(platform === 'ios' ? { appleOs: 'ios' as const } : {}),
    id: `limrun:${platform}:lease`,
    name: `Limrun ${platform}`,
    kind: platform === 'ios' ? 'simulator' : 'emulator',
    target: 'mobile',
    booted: true,
  };
}

function commandExecution(
  wait: () => Promise<{ code: number; stdout: string; stderr: string }>,
): LimrunIosCommandExecution {
  const execution = {
    on: () => execution,
    off: () => execution,
    wait,
    stop: vi.fn(),
  };
  return execution;
}

function adbResult(stdout: string) {
  return { stdout, stderr: '', exitCode: 0, stdoutBuffer: undefined };
}
