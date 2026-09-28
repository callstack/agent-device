import { expect, test, vi } from 'vitest';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { pairAndroidWearable } from './wearable-pairing.ts';

const phone: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel 9',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};
const watch: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5556',
  name: 'Wear OS Large Round',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

test('reports a human step after proving the Wear identity and ADB transport', async () => {
  const runAdb = vi.fn(async (_device, args: string[]) => ({
    stdout: args[0] === 'get-state'
      ? 'device\n'
      : args.includes('getprop')
        ? 'watch\n'
        : 'feature:android.hardware.type.watch\n',
    stderr: '',
    exitCode: 0,
  }));
  const result = await pairAndroidWearable(
    host({ discover: async () => [phone, watch], runAdb }),
    phone,
    { boot: false },
    signal(),
  );

  expect(result).toMatchObject({
    pairId: `android:${phone.id}:${watch.id}`,
    status: 'human-step-required',
    wearable: { id: watch.id },
  });
  expect(result.remainingHumanStep).toContain('companion pairing');
  expect(runAdb).toHaveBeenCalledWith(watch, ['get-state'], expect.anything(), expect.anything());
});

test('an explicit wearable selector cannot make a phone pass Wear identity verification', async () => {
  const runAdb = vi.fn(async (_device, args: string[]) => ({
    stdout: args[0] === 'get-state' ? 'device\n' : 'phone\n',
    stderr: '',
    exitCode: 0,
  }));
  await expect(
    pairAndroidWearable(
      host({ discover: async () => [phone, watch], runAdb }),
      phone,
      { wearable: { deviceId: watch.id }, boot: false },
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
});

test('physical Wear targets fail closed instead of reporting an automated pairing result', async () => {
  await expect(
    pairAndroidWearable(
      host({ discover: async () => [phone, { ...watch, kind: 'device' }] }),
      phone,
      { wearable: { deviceId: watch.id }, boot: false },
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
});

test('rejects the phone id itself as the wearable even when another candidate is named Wear', async () => {
  await expect(
    pairAndroidWearable(
      host({ discover: async () => [phone, watch] }),
      phone,
      { wearable: { deviceId: phone.id }, boot: false },
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' });
});

test('terminates a wearable emulator launched by a request that does not become ready', async () => {
  const terminate = vi.fn(async () => {});
  const stopped = { ...watch, id: 'Wear_OS_Large_Round', booted: false };
  await expect(
    pairAndroidWearable(
      host({ discover: async () => [phone, stopped], launch: () => 42, terminate }),
      phone,
      { wearable: { deviceId: stopped.id }, boot: true },
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
  expect(terminate).toHaveBeenCalledWith(42);
});

function host(overrides: {
  discover: () => Promise<readonly DeviceInfo[]>;
  runAdb?: PlatformRuntimeHost['androidTools']['runAdb'];
  launch?: (name: string, headless: boolean) => number;
  terminate?: (pid: number) => Promise<void>;
}): PlatformRuntimeHost {
  return {
    androidTools: {
      runAdb: overrides.runAdb ?? (async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    },
    deviceReadiness: {
      androidEmulator: {
        discover: overrides.discover,
        launch: overrides.launch ?? (() => 1),
        terminate: overrides.terminate ?? (async () => {}),
      },
    },
    clock: { sleep: async () => {}, now: () => 0 },
  } as unknown as PlatformRuntimeHost;
}

function signal() {
  return new AbortController().signal;
}
