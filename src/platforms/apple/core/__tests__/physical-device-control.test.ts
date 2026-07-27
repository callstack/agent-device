import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { IOS_DEVICE as SHARED_IOS_DEVICE } from '../../../../__tests__/test-utils/index.ts';
import type { DeviceInfo } from '../../../../kernel/device.ts';
import { createAppleInteractor } from '../../interactor.ts';
import { installIosApp } from '../app-install.ts';
import { closeIosApp, openIosApp } from '../app-launch.ts';
import { listIosApps } from '../app-resolution.ts';
import { resolveIosPhysicalDeviceControl } from '../physical-device-control.ts';
import { withAppleRunnerProvider } from '../runner/runner-provider.ts';
import { withAppleToolProvider } from '../tool-provider.ts';

const IOS_DEVICE: DeviceInfo = {
  ...SHARED_IOS_DEVICE,
  id: 'legacy-ios-device',
  name: 'Legacy iPhone',
};

const XCTEST_IOS_DEVICE: DeviceInfo = {
  ...IOS_DEVICE,
  iosPhysicalDeviceBackend: 'xctest',
};

test('physical-device backend defaults to CoreDevice and honors discovery evidence', () => {
  assert.equal(resolveIosPhysicalDeviceControl(IOS_DEVICE).backend, 'coredevice');
  assert.equal(resolveIosPhysicalDeviceControl(XCTEST_IOS_DEVICE).backend, 'xctest');
});

test('XCTest readiness uses xcdevice instead of devicectl', async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];

  await withAppleToolProvider(
    async (cmd, args) => {
      calls.push({ cmd, args });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async () =>
      await resolveIosPhysicalDeviceControl(XCTEST_IOS_DEVICE).ensureReady(XCTEST_IOS_DEVICE),
  );

  assert.deepEqual(calls, [
    {
      cmd: 'xcrun',
      args: ['xcdevice', 'wait', '--both', '--timeout=15', XCTEST_IOS_DEVICE.id],
    },
  ]);
  assert.deepEqual(
    await resolveIosPhysicalDeviceControl(XCTEST_IOS_DEVICE).resolveRunnerTransport(
      XCTEST_IOS_DEVICE,
    ),
    { kind: 'usbmux' },
  );
});

test('app lifecycle uses runner commands for an xctrace-only physical device', async () => {
  const commands: unknown[] = [];

  await withAppleRunnerProvider(
    async (_device, command) => {
      commands.push(command);
      return { message: 'app activated' };
    },
    { deviceId: XCTEST_IOS_DEVICE.id },
    async () => {
      await openIosApp(XCTEST_IOS_DEVICE, 'com.example.app', {
        appBundleId: 'com.example.app',
      });
      await closeIosApp(XCTEST_IOS_DEVICE, 'com.example.app');
    },
  );

  assert.equal(commands.length, 2);
  assert.deepEqual(
    commands.map((command) => {
      const { commandId: _commandId, ...rest } = command as Record<string, unknown>;
      return rest;
    }),
    [
      { command: 'activate', appBundleId: 'com.example.app' },
      { command: 'terminate', appBundleId: 'com.example.app' },
    ],
  );
});

test('default interactor screenshots stay in-band without invoking devicectl', async () => {
  const outPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-xctest-screenshot-')),
    'screen.png',
  );
  const toolCalls: string[][] = [];
  try {
    await withAppleToolProvider(
      async (_cmd, args) => {
        toolCalls.push(args);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      async () =>
        await withAppleRunnerProvider(
          async (_device, command) => {
            assert.equal(command.inlineScreenshot, true);
            return { imageBase64: Buffer.from('png-bytes').toString('base64') };
          },
          { deviceId: XCTEST_IOS_DEVICE.id },
          async () =>
            await createAppleInteractor(XCTEST_IOS_DEVICE, {
              appBundleId: 'com.example.app',
            }).screenshot(outPath),
        ),
    );

    assert.equal(await fs.readFile(outPath, 'utf8'), 'png-bytes');
    assert.equal(
      toolCalls.some((args) => args[0] === 'devicectl'),
      false,
    );
  } finally {
    await fs.rm(path.dirname(outPath), { recursive: true, force: true });
  }
});

test('CoreDevice-only app inventory and install fail with targeted XCTest guidance', async () => {
  await assert.rejects(
    () => listIosApps(XCTEST_IOS_DEVICE, 'all'),
    /App inventory is unavailable on this XCTest-backed physical iOS device/,
  );
  await assert.rejects(
    () => installIosApp(XCTEST_IOS_DEVICE, '/missing/example.app'),
    /Installing apps is unavailable on this XCTest-backed physical iOS device/,
  );
});
