import { expect, test, vi } from 'vitest';
import type { AndroidObservationHost } from '@agent-device/contracts/android-observation';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createAndroidObservationAdapter } from './observation.ts';

const device = {
  platform: 'android',
  target: 'mobile',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} satisfies DeviceInfo;

function hostFor(stdoutByCommand: ReadonlyMap<string, string>): AndroidObservationHost {
  return {
    runAdb: vi.fn(async (_device, args) => ({
      exitCode: 0,
      stdout: stdoutByCommand.get(args.join(' ')) ?? '',
      stderr: '',
    })),
    readSnapshotNodes: vi.fn(async () => []),
    openApp: vi.fn(async () => {}),
  };
}

test('answers focus and blocking-dialog questions from one observation-bound dump', async () => {
  const host = hostFor(
    new Map([
      ['shell dumpsys window windows', 'mCurrentFocus=Window{1 u0 com.example.app/.MainActivity}'],
    ]),
  );
  const observer = createAndroidObservationAdapter(host);

  await expect(
    observer.readAppFocus(device, 'com.example.app', { requireNoBlockingDialog: true }),
  ).resolves.toBe(true);
  expect(host.runAdb).toHaveBeenCalledTimes(1);
});

test('classifies an app-owned ANR without exposing dump mechanics to the daemon', async () => {
  const host = hostFor(
    new Map([
      [
        'shell dumpsys window windows',
        'mCurrentFocus=Window{1 u0 Application Not Responding: com.example.app}',
      ],
    ]),
  );

  await expect(createAndroidObservationAdapter(host).readBlockingDialog(device)).resolves.toEqual({
    status: 'dialog',
    focus: {
      package: 'com.example.app',
      focusedWindow: 'Application Not Responding: com.example.app',
      raw: 'mCurrentFocus=Window{1 u0 Application Not Responding: com.example.app}',
    },
  });
});

test('owns touch rounding and screen-size parsing behind raw host commands', async () => {
  const host = hostFor(new Map([['shell wm size', 'Physical size: 1080x2400']]));
  const observer = createAndroidObservationAdapter(host);

  await expect(observer.readScreenSize(device)).resolves.toEqual({ width: 1080, height: 2400 });
  await observer.tap(device, 12.6, 42.2);
  expect(host.runAdb).toHaveBeenLastCalledWith(device, ['shell', 'input', 'tap', '13', '42'], {
    allowFailure: true,
  });
});

test('a transient empty dump never demotes a variant that previously answered', async () => {
  const calls: string[] = [];
  let primaryReads = 0;
  const host: AndroidObservationHost = {
    ...hostFor(new Map()),
    runAdb: vi.fn(async (_device, args) => {
      const key = args.join(' ');
      calls.push(key);
      if (key === 'shell dumpsys window windows') primaryReads += 1;
      return {
        exitCode: 0,
        stdout:
          primaryReads === 2 && key === 'shell dumpsys window windows'
            ? ''
            : 'mCurrentFocus=Window{1 u0 com.example.app/.MainActivity}',
        stderr: '',
      };
    }),
  };
  const observer = createAndroidObservationAdapter(host);
  const transientDevice = { ...device, id: 'emulator-transient' };

  await observer.readAppState(transientDevice);
  await observer.readAppState(transientDevice);
  const thirdReadStart = calls.length;
  await observer.readAppState(transientDevice);

  expect(calls[thirdReadStart]).toBe('shell dumpsys window windows');
});
