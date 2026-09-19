import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { readIosDeviceReadiness } from '../ios-device-readiness.ts';
import { resolveIosPhysicalDeviceControl } from '../physical-device-control.ts';
import type { IosDeviceReadiness } from '../../runner/runner-contract.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../tool-provider.ts';

/**
 * Whether an iPhone will host development tooling is a fact the phone holds (#2683), and the
 * `devicectl` text path used to answer both of its states with one hint. These cases run the real
 * reader over recorded payloads: the state pair that must name the developer disk image is the pair
 * that used to send people to a Settings pane that was already correct.
 *
 * The payload identity fields are masked in the capture; the states the reader consumes are verbatim.
 */
const DEVICE_INFO_DETAILS_CAPTURE = fs.readFileSync(
  path.join(import.meta.dirname, 'fixtures', 'ios-device-info-details.json'),
  'utf8',
);

const IOS_DEVICE: DeviceInfo = {
  platform: 'apple',
  id: '00000000-0000-0000-0000-000000000001',
  name: 'iPhone',
  kind: 'device',
  appleOs: 'ios',
};

const XCTEST_IOS_DEVICE: DeviceInfo = { ...IOS_DEVICE, iosPhysicalDeviceBackend: 'xctest' };

test('a device reporting its toggle on and its disk image up is ready', async () => {
  const calls: string[][] = [];
  const readiness = await readDeviceDetails(DEVICE_INFO_DETAILS_CAPTURE, calls);

  assert.deepEqual(readiness, {
    available: true,
    developerMode: 'enabled',
    developerDiskImage: 'available',
  });
  assert.equal(calls.length, 1);
  const [cmd, ...args] = calls[0] ?? [];
  assert.equal(cmd, 'xcrun');
  assert.deepEqual(args.slice(0, 4), ['devicectl', 'device', 'info', 'details']);
  assert.ok(args.includes('--device') && args.includes(IOS_DEVICE.id));
  assert.ok(args.includes('--json-output') && args.includes('--timeout'));
});

test('a device reporting its toggle off says so, whatever its disk image says', async () => {
  const readiness = await readDeviceDetails(
    devicePropertiesPayload({ developerModeStatus: 'disabled', ddiServicesAvailable: false }),
  );

  assert.deepEqual(readiness, {
    available: true,
    developerMode: 'disabled',
    developerDiskImage: 'unavailable',
  });
});

test('a device with its toggle on and its disk image down reports the image, not the toggle', async () => {
  const readiness = await readDeviceDetails(
    devicePropertiesPayload({ developerModeStatus: 'enabled', ddiServicesAvailable: false }),
  );

  assert.deepEqual(readiness, {
    available: true,
    developerMode: 'enabled',
    developerDiskImage: 'unavailable',
  });
});

test('a device that answers with a spelling we do not know reports nothing', async () => {
  // Both fields present, neither recognised, and the same answer when the payload carries no device
  // properties at all: a toolchain that renames or stops sending a state must not be read as its
  // owner having switched something off.
  const readiness = await readDeviceDetails(
    devicePropertiesPayload({ developerModeStatus: 'notDetermined', ddiServicesAvailable: 'yes' }),
  );

  assert.deepEqual(readiness, {
    available: true,
    developerMode: 'unknown',
    developerDiskImage: 'unknown',
  });
  assert.deepEqual(
    await readDeviceDetails(JSON.stringify({ info: { outcome: 'success' }, result: {} })),
    { available: true, developerMode: 'unknown', developerDiskImage: 'unknown' },
  );
});

test('a device whose details cannot be read is reported unreadable rather than diagnosed', async () => {
  for (const payload of [
    'not json at all',
    '',
    JSON.stringify({ info: { outcome: 'failure' }, result: {} }),
  ]) {
    const readiness = await readDeviceDetails(payload);

    assert.equal(readiness.available, false);
    if (readiness.available) continue;
    assert.equal(readiness.reason, 'device_readiness_unreadable');
    // The hint offers a way to read the device, never a cause to fix.
    assert.match(readiness.hint, /devicectl device info details/);
    assert.doesNotMatch(readiness.hint, /Developer Mode/i);
  }
});

test('a device that fails the details command is unreadable, not unavailable', async () => {
  const readiness = await withAppleToolProvider(
    createLocalAppleToolProvider({
      runCommand: async (_cmd: string, args: string[]) => ({
        exitCode: args.includes('--json-output') ? 1 : 0,
        stdout: '',
        stderr: 'ERROR: The device could not be contacted.',
      }),
    }),
    async () => await readIosDeviceReadiness(IOS_DEVICE),
  );

  assert.equal(readiness.available, false);
});

test('a spent budget reads nothing and claims nothing', async () => {
  let toolCalls = 0;
  const readiness = await withAppleToolProvider(
    createLocalAppleToolProvider({
      runCommand: async () => {
        toolCalls += 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    }),
    async () => await readIosDeviceReadiness(IOS_DEVICE, 0),
  );

  assert.equal(toolCalls, 0);
  assert.equal(readiness.available, false);
});

test('an XCTest-backed device reports that its readiness cannot be read', async () => {
  let toolCalls = 0;
  const readiness = await withAppleToolProvider(
    createLocalAppleToolProvider({
      runCommand: async () => {
        toolCalls += 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    }),
    async () =>
      await resolveIosPhysicalDeviceControl(XCTEST_IOS_DEVICE).readDeviceReadiness(
        XCTEST_IOS_DEVICE,
      ),
  );

  assert.equal(toolCalls, 0);
  assert.equal(readiness.available, false);
  if (readiness.available) return;
  assert.equal(readiness.reason, 'device_readiness_unreadable');
  assert.match(readiness.hint, /XCTest/);
});

test('the CoreDevice backend publishes the device report', async () => {
  const readiness = await withAppleToolProvider(
    createLocalAppleToolProvider({
      runCommand: async (_cmd: string, args: string[]) => {
        const outputPath = jsonOutputPath(args);
        if (outputPath) fs.writeFileSync(outputPath, DEVICE_INFO_DETAILS_CAPTURE);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    }),
    async () => await resolveIosPhysicalDeviceControl(IOS_DEVICE).readDeviceReadiness(IOS_DEVICE),
  );

  assert.equal(readiness.available, true);
  if (!readiness.available) return;
  assert.equal(readiness.developerMode, 'enabled');
  assert.equal(readiness.developerDiskImage, 'available');
});

function devicePropertiesPayload(deviceProperties: Record<string, unknown>): string {
  return JSON.stringify({ info: { outcome: 'success' }, result: { deviceProperties } });
}

async function readDeviceDetails(
  payload: string,
  calls: string[][] = [],
): Promise<IosDeviceReadiness> {
  return await withAppleToolProvider(
    createLocalAppleToolProvider({
      runCommand: async (cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        const outputPath = jsonOutputPath(args);
        if (outputPath) fs.writeFileSync(outputPath, payload);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    }),
    async () => await readIosDeviceReadiness(IOS_DEVICE),
  );
}

function jsonOutputPath(args: string[]): string | undefined {
  const index = args.indexOf('--json-output');
  return index >= 0 ? args[index + 1] : undefined;
}
