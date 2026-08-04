import { test, expect, vi } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

vi.mock('../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/exec.ts')>();
  return {
    ...actual,
    runCmd: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    runCmdBackground: vi.fn(),
  };
});
vi.mock('../app-log-stream.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app-log-stream.ts')>();
  return { ...actual, sleep: vi.fn(async () => {}) };
});

import { runCmd, runCmdBackground } from '../../utils/exec.ts';
import { readRecentAndroidLogcatForPackage, startAndroidAppLog } from '../app-log-android.ts';

const mockRunCmd = vi.mocked(runCmd);
const mockRunCmdBackground = vi.mocked(runCmdBackground);

type MockChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  pid?: number;
  killed: boolean;
  kill: (signal?: NodeJS.Signals) => boolean;
};

function makeMockChild(pid?: number): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  if (pid !== undefined) {
    child.pid = pid;
  }
  child.killed = false;
  child.kill = () => {
    if (child.killed) return false;
    child.killed = true;
    queueMicrotask(() => child.emit('close', 0));
    return true;
  };
  return child;
}

function mockBackgroundChild(child: MockChild): ReturnType<typeof runCmdBackground> {
  return {
    child: child as unknown as ReturnType<typeof runCmdBackground>['child'],
    wait: new Promise((resolve) => {
      child.once('close', (code) => resolve({ stdout: '', stderr: '', exitCode: code ?? 0 }));
    }),
  };
}

test('startAndroidAppLog returns to active state after a successful reattach', async () => {
  const logDir = mkdtempForTestSync('agent-device-android-log-');
  const stream = fs.createWriteStream(path.join(logDir, 'app.log'));
  const firstChild = makeMockChild(1001);
  const secondChild = makeMockChild(1002);

  mockRunCmd.mockReset();
  let pidLookupCount = 0;
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.join(' ') === '-s emulator-5554 shell pidof com.example.app') {
      pidLookupCount += 1;
      return {
        stdout: pidLookupCount === 1 ? '111\n' : '222\n',
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  mockRunCmdBackground.mockReset();
  let spawnCount = 0;
  mockRunCmdBackground.mockImplementation(() => {
    spawnCount += 1;
    if (spawnCount === 1) {
      return mockBackgroundChild(firstChild);
    }
    return mockBackgroundChild(secondChild);
  });

  const appLog = await startAndroidAppLog('emulator-5554', 'com.example.app', stream, []);
  await vi.waitFor(() => {
    expect(mockRunCmdBackground).toHaveBeenCalledTimes(1);
  });
  assert.equal(appLog.getState(), 'active');

  firstChild.emit('close', 1);
  await vi.waitFor(() => {
    expect(mockRunCmdBackground).toHaveBeenCalledTimes(2);
  });
  assert.equal(appLog.getState(), 'active');

  await appLog.stop();
  await appLog.wait;
});

test('startAndroidAppLog reports active for provider streams without host pid', async () => {
  const logDir = mkdtempForTestSync('agent-device-android-log-');
  const stream = fs.createWriteStream(path.join(logDir, 'app.log'));
  const child = makeMockChild();

  mockRunCmd.mockReset();
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.join(' ') === '-s emulator-5554 shell pidof com.example.app') {
      return { stdout: '111\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  mockRunCmdBackground.mockReset();
  mockRunCmdBackground.mockImplementation(() => mockBackgroundChild(child));

  const appLog = await startAndroidAppLog('emulator-5554', 'com.example.app', stream, []);
  await vi.waitFor(() => {
    expect(mockRunCmdBackground).toHaveBeenCalledTimes(1);
  });

  assert.equal(appLog.getState(), 'active');

  await appLog.stop();
  await appLog.wait;
});

test('readRecentAndroidLogcatForPackage keeps lines for package-associated prior pids', async () => {
  mockRunCmd.mockReset();
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.join(' ') === '-s emulator-5554 shell pidof com.example.app') {
      return { stdout: '4321\n', stderr: '', exitCode: 0 };
    }
    if (args.join(' ') === '-s emulator-5554 logcat -d -v time -t 4000') {
      return {
        stdout:
          '04-01 10:00:00.000 I/ActivityManager( 9999): Process com.example.app (pid 1234) has died\n' +
          '04-01 10:00:00.500 D/GIBSDK  (1234): POST https://api.example.com/v1/submit status=504 duration=15000\n' +
          '04-01 10:00:01.000 I/ActivityManager( 9999): Start proc 4321:com.example.app/u0a123 for top-activity\n' +
          '04-01 10:00:01.500 D/GIBSDK  (4321): GET https://api.example.com/v1/ping status=200\n' +
          '04-01 10:00:02.000 D/OtherTag (7777): GET https://example.com/ignore status=200\n',
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const result = await readRecentAndroidLogcatForPackage('emulator-5554', 'com.example.app');

  assert.ok(result);
  expect(result?.pid).toBe('4321');
  expect(result?.recoveredPids).toEqual(['4321', '1234']);
  expect(result?.text).toContain('(1234): POST https://api.example.com/v1/submit');
  expect(result?.text).toContain('(4321): GET https://api.example.com/v1/ping');
  expect(result?.text).not.toContain('https://example.com/ignore');
});
