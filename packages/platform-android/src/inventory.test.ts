import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type {
  DeviceInventoryHostFor,
  HostCommandRequest,
  PlatformRequestScope,
} from '@agent-device/contracts/platform-runtime-host';
import { createAndroidInventory } from './inventory.ts';

const scope: PlatformRequestScope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => undefined },
  progress: { report: () => undefined },
};

test.each([
  ['include-stopped', true],
  ['running-only', false],
] as const)(
  'Android inventory %s policy owns stopped-AVD placeholder resolution',
  async (androidAvdSelection, includesStoppedAvd) => {
    const calls: HostCommandRequest[] = [];
    const host = createHost(async (request) => {
      calls.push(request);
      const key = request.args.join('\0');
      if (request.executable === 'emulator') return result('Pixel_9_Pro_XL\nLiving_Room_TV\n');
      if (key === 'devices\0-l') {
        return result(
          'List of devices attached\nemulator-5554 device model:Pixel_9_Pro_XL\nphysical-1 device model:Phone\n',
        );
      }
      if (key.includes('ro.boot.qemu.avd_name')) return result('Pixel_9_Pro_XL\n');
      if (key.includes('sys.boot_completed')) return result('1\n');
      if (key.includes('ro.build.characteristics')) return result('phone\n');
      if (key.includes('has-feature')) return result('false\n');
      if (key.includes('pm\0list\0features')) return result('');
      throw new Error(`Unexpected command: ${request.executable} ${request.args.join(' ')}`);
    });

    const devices = await createAndroidInventory(host).discover(
      { androidSerialAllowlist: ['emulator-5554'], androidAvdSelection },
      scope,
    );

    assert.deepEqual(
      devices.map((candidate) => [candidate.id, candidate.name, candidate.booted]),
      [
        ['emulator-5554', 'Pixel 9 Pro XL', true],
        ...(includesStoppedAvd ? [['Living_Room_TV', 'Living_Room_TV', false] as const] : []),
      ],
    );
    assert.ok(calls.every((call) => call.timeoutMs === 10_000));
    assert.ok(calls.every((call) => call.allowFailure === true));
  },
);

test('Android inventory fails closed when adb is unavailable', async () => {
  const host = createHost(async () => result(''), { adb: undefined });
  await assert.rejects(
    createAndroidInventory(host).discover({}, scope),
    (error: unknown) => error instanceof AppError && error.code === 'TOOL_MISSING',
  );
});

test('Android inventory honors captured SDK roots and classifies adb transport failures', async () => {
  const calls: HostCommandRequest[] = [];
  const host = createHost(
    async (request) => {
      calls.push(request);
      return result('', 'error: device offline', 1);
    },
    { adb: undefined, emulator: undefined },
    async (candidate) => candidate === '/custom-sdk/platform-tools/adb',
  );

  await assert.rejects(
    createAndroidInventory(host, { sdkRoots: ['/custom-sdk'] }).discover({}, scope),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'COMMAND_FAILED' &&
      error.details?.adbFailure === 'device_offline' &&
      error.details?.retriable === true,
  );
  assert.equal(calls[0]?.executable, '/custom-sdk/platform-tools/adb');
});

test('Android inventory prepares the legacy toolchain before an ANDROID_HOME-only discovery', async () => {
  const preparedFamilies: string[] = [];
  const host = {
    ...createHost(
      async (request) => {
        if (request.args.join('\0') === 'devices\0-l') return result('');
        if (request.executable.endsWith('/emulator')) return result('');
        throw new Error(`Unexpected command: ${request.executable} ${request.args.join(' ')}`);
      },
      { adb: undefined, emulator: undefined },
      async (candidate) =>
        candidate === '/android-home/platform-tools/adb' ||
        candidate === '/android-home/emulator/emulator',
    ),
    toolchains: {
      prepare: async (family: string) => {
        preparedFamilies.push(family);
      },
    },
  };

  await createAndroidInventory(host, { sdkRoots: ['/android-home'] }).discover({}, scope);

  assert.deepEqual(preparedFamilies, ['android']);
});

function createHost(
  run: DeviceInventoryHostFor<'android'>['commands']['run'],
  tools: { adb?: string; emulator?: string } = { adb: 'adb', emulator: 'emulator' },
  isExecutable: DeviceInventoryHostFor<'android'>['files']['isExecutable'] = async () => false,
): DeviceInventoryHostFor<'android'> {
  return {
    commands: {
      which: async (executable) => tools[executable as keyof typeof tools],
      run,
    },
    toolchains: { prepare: async () => undefined },
    files: {
      isExecutable,
      createTemporaryTextFile: async () => {
        throw new Error('unused');
      },
    },
    homeDirectory: '/Users/test',
  };
}

function result(stdout: string, stderr = '', exitCode = 0) {
  return { stdout, stderr, exitCode };
}
