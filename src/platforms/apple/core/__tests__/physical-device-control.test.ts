import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { deviceBackendForDevice } from '../../../../core/capabilities.ts';
import { IOS_DEVICE as SHARED_IOS_DEVICE } from '../../../../__tests__/test-utils/index.ts';
import type { DeviceInfo } from '../../../../kernel/device.ts';
import { installIosApp } from '../app-install.ts';
import { closeIosApp, openIosApp } from '../app-launch.ts';
import { listIosApps } from '../app-resolution.ts';
import {
  resolveIosPhysicalDeviceControl,
  type IosPhysicalDeviceControl,
} from '../physical-device-control.ts';
import {
  createIosPhysicalDeviceBackendRegistry,
  iosPhysicalDeviceBackendRegistry,
  recordDiscoveredIosPhysicalDeviceBackends,
} from '../physical-device-control-registry.ts';
import { withAppleRunnerProvider } from '../runner/runner-provider.ts';
import { captureScreenshotViaRunner } from '../screenshot.ts';
import { withAppleToolProvider } from '../tool-provider.ts';

const IOS_DEVICE: DeviceInfo = {
  ...SHARED_IOS_DEVICE,
  id: 'legacy-ios-device',
  name: 'Legacy iPhone',
};

afterEach(() => {
  iosPhysicalDeviceBackendRegistry.clear();
});

test('physical-device backend registry defaults to CoreDevice and records xctrace-only devices', () => {
  const registry = createIosPhysicalDeviceBackendRegistry();
  assert.equal(registry.backendForDevice(IOS_DEVICE), 'coredevice');

  registry.recordBackend(IOS_DEVICE.id, 'xctest');
  assert.equal(registry.backendForDevice(IOS_DEVICE), 'xctest');
});

test('CoreDevice discovery wins when the same device is also visible to xctrace', () => {
  recordDiscoveredIosPhysicalDeviceBackends([IOS_DEVICE], [IOS_DEVICE]);
  assert.equal(deviceBackendForDevice(IOS_DEVICE), 'coredevice');

  recordDiscoveredIosPhysicalDeviceBackends([], [IOS_DEVICE]);
  assert.equal(deviceBackendForDevice(IOS_DEVICE), 'xctest');
});

test('physical-device control selection accepts a mocked backend registry', () => {
  const registry = {
    backendForDevice: vi.fn(() => 'xctest' as const),
  };
  const control: IosPhysicalDeviceControl = resolveIosPhysicalDeviceControl(IOS_DEVICE, registry);

  assert.equal(control.backend, 'xctest');
  assert.deepEqual(registry.backendForDevice.mock.calls, [[IOS_DEVICE]]);
});

test('XCTest readiness uses xcdevice instead of devicectl', async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  iosPhysicalDeviceBackendRegistry.recordBackend(IOS_DEVICE.id, 'xctest');

  await withAppleToolProvider(
    async (cmd, args) => {
      calls.push({ cmd, args });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async () => await resolveIosPhysicalDeviceControl(IOS_DEVICE).ensureReady(IOS_DEVICE),
  );

  assert.deepEqual(calls, [
    {
      cmd: 'xcrun',
      args: ['xcdevice', 'wait', '--both', '--timeout=15', IOS_DEVICE.id],
    },
  ]);
  assert.equal(
    await resolveIosPhysicalDeviceControl(IOS_DEVICE).resolveRunnerTunnelIp(IOS_DEVICE),
    null,
  );
});

test('app lifecycle uses runner commands for an xctrace-only physical device', async () => {
  const commands: unknown[] = [];
  iosPhysicalDeviceBackendRegistry.recordBackend(IOS_DEVICE.id, 'xctest');

  await withAppleRunnerProvider(
    async (_device, command) => {
      commands.push(command);
      return { message: 'app activated' };
    },
    { deviceId: IOS_DEVICE.id },
    async () => {
      await openIosApp(IOS_DEVICE, 'com.example.app', {
        appBundleId: 'com.example.app',
      });
      await closeIosApp(IOS_DEVICE, 'com.example.app');
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

test('runner screenshots stay in-band when CoreDevice file copy is unavailable', async () => {
  const outPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-xctest-screenshot-')),
    'screen.png',
  );
  iosPhysicalDeviceBackendRegistry.recordBackend(IOS_DEVICE.id, 'xctest');
  try {
    await withAppleRunnerProvider(
      async (_device, command) => {
        assert.equal(command.inlineScreenshot, true);
        return { imageBase64: Buffer.from('png-bytes').toString('base64') };
      },
      { deviceId: IOS_DEVICE.id },
      async () =>
        await captureScreenshotViaRunner(IOS_DEVICE, outPath, 'com.example.app', undefined),
    );

    assert.equal(await fs.readFile(outPath, 'utf8'), 'png-bytes');
  } finally {
    await fs.rm(path.dirname(outPath), { recursive: true, force: true });
  }
});

test('CoreDevice-only app inventory and install fail with targeted XCTest guidance', async () => {
  iosPhysicalDeviceBackendRegistry.recordBackend(IOS_DEVICE.id, 'xctest');

  await assert.rejects(
    () => listIosApps(IOS_DEVICE, 'all'),
    /App inventory is unavailable on this XCTest-backed physical iOS device/,
  );
  await assert.rejects(
    () => installIosApp(IOS_DEVICE, '/missing/example.app'),
    /Installing apps is unavailable on this XCTest-backed physical iOS device/,
  );
});
