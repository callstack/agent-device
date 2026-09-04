import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { ManagedLease } from '@agent-device/contracts/managed-device-allocation';
import type {
  DeviceInventoryHostFor,
  PlatformRequestScope,
} from '@agent-device/contracts/platform-runtime-host';
import { createAndroidInventoryModule } from '@agent-device/platform-android';
import {
  resolveAndroidAdbProvider,
  runAndroidHostAdb,
} from '@agent-device/platform-android/mechanics';
import { runCmd } from '@agent-device/host-kit/command';
import { mkdtempForTestSync } from './__tests__/test-utils/tmp-dir.ts';
import {
  createManagedLeaseReachability,
  readManagedLeaseEnvironment,
} from './managed-device-reachability.ts';
import './platform-runtime-android-adb-host.ts';

const iosLease: ManagedLease = {
  id: 'lease-ios',
  ttlDeadline: 1_000,
  device: { address: 'ios-managed-1' },
  environment: { SIMLOCK_IOS_DEVICE_SET: '/private/simlock/sets/ios' },
};

const androidLease: ManagedLease = {
  id: 'lease-android',
  ttlDeadline: 1_000,
  device: { address: 'emulator-15037' },
  environment: { ANDROID_ADB_SERVER_PORT: '15037' },
};

test('reads the exact managed lease environment contract and ignores unrelated keys', () => {
  expect(
    readManagedLeaseEnvironment('ios', {
      SIMLOCK_IOS_DEVICE_SET: ' /private/simlock/sets/ios ',
      unrelated: 'preserved',
    }),
  ).toEqual({ platform: 'ios', deviceSetPath: '/private/simlock/sets/ios' });
  expect(
    readManagedLeaseEnvironment('android', {
      ANDROID_ADB_SERVER_PORT: '15037',
      unrelated: 'preserved',
    }),
  ).toEqual({ platform: 'android', adbServerPort: 15_037 });
});

test('rejects missing and malformed managed lease environment values', () => {
  expect(readManagedLeaseEnvironment('ios', {})).toEqual({
    code: 'LEASE_ENVIRONMENT_INVALID',
    platform: 'ios',
    key: 'SIMLOCK_IOS_DEVICE_SET',
  });
  for (const value of ['', '0', '65536', '15.037', 'port']) {
    expect(readManagedLeaseEnvironment('android', { ANDROID_ADB_SERVER_PORT: value })).toEqual({
      code: 'LEASE_ENVIRONMENT_INVALID',
      platform: 'android',
      key: 'ANDROID_ADB_SERVER_PORT',
    });
  }
});

test('creates an iOS managed device with the allocator-owned simulator set', async () => {
  const reachability = createManagedLeaseReachability({ platform: 'ios', lease: iosLease });

  expect(reachability.device).toEqual({
    platform: 'apple',
    appleOs: 'ios',
    id: 'ios-managed-1',
    name: 'ios-managed-1',
    kind: 'simulator',
    target: 'mobile',
    simulatorSetPath: '/private/simlock/sets/ios',
  });
  await expect(reachability.run(async () => 'ios-result')).resolves.toBe('ios-result');
});

test.skipIf(process.platform === 'win32')(
  'runs Android managed adb mechanics through the lease port without changing process env',
  async () => {
    const tmpDir = mkdtempForTestSync('agent-device-managed-adb-');
    const adbPath = path.join(tmpDir, 'adb');
    fs.writeFileSync(
      adbPath,
      [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        'const output = args.includes("devices") && args.includes("-l")',
        String.raw`  ? "List of devices attached\nemulator-15037 device model:Managed_Pixel\n"`,
        '  : args.includes("ro.boot.qemu.avd_name")',
        String.raw`    ? "Managed_Pixel\n"`,
        '    : args.includes("sys.boot_completed")',
        String.raw`      ? "1\n"`,
        '      : args.includes("ro.build.characteristics")',
        String.raw`        ? "phone\n"`,
        '        : args.includes("has-feature") || args.includes("pm")',
        String.raw`          ? "false\n"`,
        '          : JSON.stringify({args, port: process.env.ANDROID_ADB_SERVER_PORT ?? null});',
        'process.stdout.write(output);',
        '',
      ].join('\n'),
    );
    fs.chmodSync(adbPath, 0o755);
    const previousPath = process.env.PATH;
    const previousPort = process.env.ANDROID_ADB_SERVER_PORT;
    process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
    try {
      const reachability = createManagedLeaseReachability({
        platform: 'android',
        lease: androidLease,
      });
      const results = await reachability.run(async () => {
        const inventoryHost: DeviceInventoryHostFor<'android'> = {
          commands: {
            which: async () => 'adb',
            run: async (request, signal) =>
              await runCmd(request.executable, [...request.args], {
                allowFailure: request.allowFailure,
                signal,
                timeoutMs: request.timeoutMs,
              }),
          },
          files: {
            isExecutable: async () => false,
            createTemporaryTextFile: async () => {
              throw new Error('unused');
            },
          },
          homeDirectory: tmpDir,
          toolchains: { prepare: async () => {} },
        };
        const inventory = await (
          await createAndroidInventoryModule({ sdkRoots: [tmpDir] }).loadInventory(inventoryHost)
        ).discover(
          { androidSerialAllowlist: [reachability.device.id], androidAvdSelection: 'running-only' },
          {
            signal: new AbortController().signal,
            diagnostics: { emit: () => {} },
            progress: { report: () => {} },
          } satisfies PlatformRequestScope,
        );
        const host = await runAndroidHostAdb(['devices']);
        const hostWithWrongPort = await runAndroidHostAdb(['-P', '9999', 'devices']);
        const provider = resolveAndroidAdbProvider(reachability.device);
        const serial = await provider.exec(['shell', 'id']);
        return {
          inventory,
          host: JSON.parse(host.stdout),
          hostWithWrongPort: JSON.parse(hostWithWrongPort.stdout),
          serial: JSON.parse(serial.stdout),
        };
      });
      const outside = JSON.parse((await runAndroidHostAdb(['devices'])).stdout);

      expect(results).toEqual({
        inventory: [
          {
            platform: 'android',
            id: 'emulator-15037',
            name: 'Managed Pixel',
            kind: 'emulator',
            target: 'mobile',
            booted: true,
          },
        ],
        host: { args: ['-P', '15037', 'devices'], port: '15037' },
        hostWithWrongPort: { args: ['-P', '15037', 'devices'], port: '15037' },
        serial: {
          args: ['-P', '15037', '-s', 'emulator-15037', 'shell', 'id'],
          port: '15037',
        },
      });
      expect(outside).toEqual({ args: ['devices'], port: previousPort ?? null });
      expect(process.env.ANDROID_ADB_SERVER_PORT).toBe(previousPort);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  },
);

test('fails before Android mechanics load when a managed lease environment is invalid', () => {
  expect(() =>
    createManagedLeaseReachability({
      platform: 'android',
      lease: { ...androidLease, environment: { ANDROID_ADB_SERVER_PORT: 'not-a-port' } },
    }),
  ).toThrowError(
    expect.objectContaining({
      code: 'COMMAND_FAILED',
      details: expect.objectContaining({
        reason: 'managed_lease_environment_invalid',
        key: 'ANDROID_ADB_SERVER_PORT',
        retriable: false,
      }),
    }),
  );
});
