import { expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createLocalAppleToolProvider, withAppleToolProvider } from './core/tool-provider.ts';
import { resolveSimulatorSnapshotTarget } from './snapshot-target.ts';

const ios = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'ios-1',
  name: 'iPhone',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
} as const satisfies DeviceInfo;

test('resolves exact app pid, runtime, and launch generation from simctl', async () => {
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === 'spawn') {
      return {
        stdout: [
          '90\t0\tUIKitApplication:com.example.app.beta[wrong][rb-legacy]',
          '42\t0\tUIKitApplication:com.example.app[launch-a][rb-legacy]',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    }
    return {
      stdout: JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ udid: ios.id }],
        },
      }),
      stderr: '',
      exitCode: 0,
    };
  });
  const provider = createLocalAppleToolProvider({ simctl: { run } });

  const result = await withAppleToolProvider(
    provider,
    async () =>
      await resolveSimulatorSnapshotTarget(ios, 'com.example.app', new AbortController().signal),
  );

  expect(result).toEqual({
    udid: 'ios-1',
    runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0',
    pid: 42,
    generation: '42:UIKitApplication:com.example.app[launch-a][rb-legacy]',
    targetId: 'ios-1:com.example.app',
  });
});
