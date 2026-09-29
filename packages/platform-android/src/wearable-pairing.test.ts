import { expect, test, vi } from 'vitest';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { deviceShellArgv } from '@agent-device/kernel/device-shell';
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
    stdout:
      args[0] === 'get-state'
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

test('keeps Wear discovery inside the daemon-provided Android device boundary', async () => {
  const androidSerialAllowlist = ['emulator-5556'];
  const discover = vi.fn(async (_input?: unknown) => [phone, watch]);
  const runAdb = vi.fn(async (_device, args: string[]) => ({
    stdout:
      args[0] === 'get-state'
        ? 'device\n'
        : args.includes('getprop')
          ? 'watch\n'
          : 'feature:android.hardware.type.watch\n',
    stderr: '',
    exitCode: 0,
  }));

  await pairAndroidWearable(
    host({ discover, runAdb }),
    phone,
    { boot: false, androidSerialAllowlist },
    signal(),
  );

  expect(discover).toHaveBeenCalledWith(
    {
      platform: 'android',
      androidAvdSelection: 'include-stopped',
      androidSerialAllowlist,
    },
    expect.anything(),
  );
});

test('automatic selection recognizes a booted Wear target without a Wear label', async () => {
  const unnamedWearable = { ...watch, name: 'Fossil Gen 6' };
  const runAdb = vi.fn(async (_device, args: string[]) => ({
    stdout:
      args[0] === 'get-state'
        ? 'device\n'
        : args.includes('getprop')
          ? 'watch\n'
          : 'feature:android.hardware.type.watch\n',
    stderr: '',
    exitCode: 0,
  }));
  const result = await pairAndroidWearable(
    host({ discover: async () => [phone, unnamedWearable], runAdb }),
    phone,
    { boot: false },
    signal(),
  );
  expect(result.wearable.name).toBe('Fossil Gen 6');
  expect(runAdb).toHaveBeenCalledWith(
    unnamedWearable,
    deviceShellArgv('adb', 'shell', ['pm', 'list', 'features']),
    expect.anything(),
    expect.anything(),
  );
});

test('automatic selection skips an unresponsive candidate and keeps scanning for Wear features', async () => {
  const unresponsive = { ...watch, id: 'emulator-5558', name: 'Android Device' };
  const unnamedWearable = { ...watch, name: 'Fossil Gen 6' };
  const runAdb = vi.fn(async (device: DeviceInfo, args: readonly string[]) => {
    if (args[0] === 'get-state') return { stdout: 'device\n', stderr: '', exitCode: 0 };
    if (args.includes('getprop')) return { stdout: 'watch\n', stderr: '', exitCode: 0 };
    if (device.id === unresponsive.id) {
      return { stdout: '', stderr: 'device offline', exitCode: 1 };
    }
    return {
      stdout: 'feature:android.hardware.type.watch\n',
      stderr: '',
      exitCode: 0,
    };
  });

  const result = await pairAndroidWearable(
    host({ discover: async () => [phone, unresponsive, unnamedWearable], runAdb }),
    phone,
    { boot: false },
    signal(),
  );

  expect(result.wearable.id).toBe(unnamedWearable.id);
  expect(runAdb).toHaveBeenCalledWith(
    unresponsive,
    deviceShellArgv('adb', 'shell', ['pm', 'list', 'features']),
    expect.anything(),
    expect.anything(),
  );
  expect(runAdb).toHaveBeenCalledWith(
    unnamedWearable,
    ['get-state'],
    expect.anything(),
    expect.anything(),
  );
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

test('boots a stopped Wear emulator, rediscovers it, then proves its ADB identity', async () => {
  const stopped = { ...watch, id: 'Wear_OS_Large_Round', booted: false };
  const launched: number[] = [];
  let discoveries = 0;
  const runAdb = vi.fn(async (_device, args: string[]) => ({
    stdout:
      args[0] === 'get-state'
        ? 'device\n'
        : args.includes('getprop')
          ? 'watch\n'
          : 'feature:android.hardware.type.watch\n',
    stderr: '',
    exitCode: 0,
  }));
  const result = await pairAndroidWearable(
    host({
      discover: async () => {
        discoveries += 1;
        return [phone, discoveries === 1 ? stopped : { ...stopped, booted: true }];
      },
      runAdb,
      launch: (_name) => {
        launched.push(42);
        return 42;
      },
    }),
    phone,
    { wearable: { deviceId: stopped.id }, boot: true },
    signal(),
  );

  expect(launched).toEqual([42]);
  expect(discoveries).toBe(2);
  expect(result.wearable.booted).toBe(true);
  expect(result.status).toBe('human-step-required');
  expect(runAdb).toHaveBeenCalledWith(
    { ...stopped, booted: true },
    ['get-state'],
    expect.anything(),
    expect.anything(),
  );
});

test('Wear boot polling cannot replace the launched emulator with a same-named physical watch', async () => {
  const stopped = { ...watch, id: 'Wear_OS_Large_Round', booted: false };
  const physicalWatch = { ...stopped, id: 'physical-watch', kind: 'device' as const, booted: true };
  const bootedEmulator = { ...stopped, booted: true };
  let discoveries = 0;
  const runAdb = vi.fn(async (_device: DeviceInfo, args: readonly string[]) => ({
    stdout:
      args[0] === 'get-state'
        ? 'device\n'
        : args.includes('getprop')
          ? 'watch\n'
          : 'feature:android.hardware.type.watch\n',
    stderr: '',
    exitCode: 0,
  }));
  const terminate = vi.fn(async () => {});

  const result = await pairAndroidWearable(
    host({
      discover: async () => {
        discoveries += 1;
        return discoveries === 1 ? [phone, stopped] : [phone, physicalWatch, bootedEmulator];
      },
      runAdb,
      launch: () => 42,
      terminate,
    }),
    phone,
    { wearable: { deviceId: stopped.id }, boot: true },
    signal(),
  );

  expect(result.wearable).toMatchObject({ id: stopped.id, kind: 'emulator', booted: true });
  expect(runAdb).toHaveBeenCalledWith(
    bootedEmulator,
    ['get-state'],
    expect.anything(),
    expect.anything(),
  );
  expect(runAdb.mock.calls.some(([device]) => device.id === physicalWatch.id)).toBe(false);
  expect(terminate).not.toHaveBeenCalled();
});

function host(overrides: {
  discover: PlatformRuntimeHost['deviceReadiness']['androidEmulator']['discover'];
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
