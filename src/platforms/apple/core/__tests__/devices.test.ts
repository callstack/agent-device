import { isIosFamily } from '../../../../kernel/device.ts';
import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import {
  isAppleProductType,
  isAppleTvProductType,
  isSupportedAppleDevicectlDevice,
  listAppleDevices,
  parseXctracePhysicalAppleDevices,
  resolveAppleTargetFromDevicectlDevice,
} from '../devices.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../tool-provider.ts';
import type { ExecResult } from '../../../../utils/exec.ts';

const toolCalls: Array<[string, string[]]> = [];
let mockRunCommand: (cmd: string, args: string[]) => Promise<ExecResult>;
let mockWhichCommand: (cmd: string) => Promise<boolean>;

beforeEach(() => {
  toolCalls.length = 0;
  mockRunCommand = async () => ({ stdout: '', stderr: '', exitCode: 0 });
  mockWhichCommand = async () => true;
});

async function withMockedPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform;
  // Some Apple discovery paths are gated on process.platform at runtime, so
  // these unit tests temporarily override it and always restore it in finally.
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}

function createSimctlDevicesPayload() {
  return JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
        {
          name: 'iPhone 16',
          udid: 'sim-1',
          state: 'Booted',
          isAvailable: true,
        },
      ],
    },
  });
}

test('resolveAppleTargetFromDevicectlDevice detects tvOS from platform', () => {
  const target = resolveAppleTargetFromDevicectlDevice({
    hardwareProperties: { platform: 'tvOS' },
    deviceProperties: { name: 'Living Room' },
  });
  assert.equal(target, 'tv');
});

test('resolveAppleTargetFromDevicectlDevice detects AppleTV from product type', () => {
  const target = resolveAppleTargetFromDevicectlDevice({
    hardwareProperties: { platform: '' },
    deviceProperties: { name: 'Living Room', productType: 'AppleTV11,1' },
  });
  assert.equal(target, 'tv');
});

test('isSupportedAppleDevicectlDevice handles renamed AppleTV devices', () => {
  assert.equal(
    isSupportedAppleDevicectlDevice({
      hardwareProperties: { platform: '' },
      deviceProperties: { name: 'Living Room', productType: 'AppleTV11,1' },
    }),
    true,
  );
});

test('apple product type helpers classify iOS and tvOS product families', () => {
  assert.equal(isAppleProductType('iPhone16,2'), true);
  assert.equal(isAppleProductType('AppleTV11,1'), true);
  assert.equal(isAppleProductType('RealityDevice14,1'), true);
  assert.equal(isAppleTvProductType('AppleTV11,1'), true);
  assert.equal(isAppleTvProductType('iPhone16,2'), false);
});

test('listAppleDevices orders simulators by iPhone, iPad, tvOS, then physical devices', async () => {
  mockRunCommand = async (_cmd, args) => {
    if (args.join(' ') === 'simctl list devices -j') {
      return {
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.tvOS-18-0': [
              {
                name: 'Apple TV 4K (3rd generation)',
                udid: 'tvos-sim',
                state: 'Shutdown',
                isAvailable: true,
              },
            ],
            'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
              {
                name: 'iPad Pro 13-inch',
                udid: 'ipad-sim',
                state: 'Shutdown',
                isAvailable: true,
              },
              {
                name: 'iPhone 16',
                udid: 'iphone-sim',
                state: 'Shutdown',
                isAvailable: true,
              },
            ],
          },
        }),
        stderr: '',
        exitCode: 0,
      };
    }

    if (args[0] === 'devicectl' && args[1] === 'list' && args[2] === 'devices') {
      const jsonPath = String(args[4]);
      await fs.writeFile(
        jsonPath,
        JSON.stringify({
          result: {
            devices: [
              {
                name: 'My iPhone',
                hardwareProperties: {
                  platform: 'iOS',
                  udid: 'physical-iphone',
                  productType: 'iPhone16,2',
                },
              },
            ],
          },
        }),
        'utf8',
      );
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (args.join(' ') === 'xctrace list devices') {
      return { stdout: '== Devices ==', stderr: '', exitCode: 0 };
    }

    throw new Error(`unexpected xcrun args: ${args.join(' ')}`);
  };

  const devices = await withMockedPlatform(
    'darwin',
    async () => await withMockedAppleTools(async () => await listAppleDevices()),
  );

  assert.deepEqual(
    devices.slice(0, 4).map((device) => device.id),
    ['iphone-sim', 'ipad-sim', 'tvos-sim', 'physical-iphone'],
  );
});

test('parseXctracePhysicalAppleDevices parses only physical devices from the Devices section', () => {
  const parsed = parseXctracePhysicalAppleDevices(
    [
      '== Devices ==',
      'My iPhone [00008020-001C2D2234567890]',
      'Living Room Apple TV [tv-udid-1]',
      'Studio Mac [mac-udid-1]',
      '== Devices Offline ==',
      'Unknown',
      'Offline iPhone [offline-udid]',
      '== Simulators ==',
      'iPhone 16 (18.0) (sim-1)',
    ].join('\n'),
  );

  assert.deepEqual(parsed, [
    {
      platform: 'apple',
      id: '00008020-001C2D2234567890',
      name: 'My iPhone',
      kind: 'device',
      target: 'mobile',
      appleOs: 'ios',
      booted: true,
    },
    {
      platform: 'apple',
      id: 'tv-udid-1',
      name: 'Living Room Apple TV',
      kind: 'device',
      target: 'tv',
      appleOs: 'tvos',
      booted: true,
    },
  ]);
});

test('parseXctracePhysicalAppleDevices tags physical iPads as iPadOS', () => {
  const parsed = parseXctracePhysicalAppleDevices(
    ['== Devices ==', 'Studio iPad Pro [ipad-udid-1]'].join('\n'),
  );
  assert.deepEqual(parsed, [
    {
      platform: 'apple',
      id: 'ipad-udid-1',
      name: 'Studio iPad Pro',
      kind: 'device',
      target: 'mobile',
      appleOs: 'ipados',
      booted: true,
    },
  ]);
});

test('parseXctracePhysicalAppleDevices tags Apple Vision devices as visionOS', () => {
  const parsed = parseXctracePhysicalAppleDevices(
    ['== Devices ==', 'Apple Vision Pro [vision-udid-1]'].join('\n'),
  );
  assert.deepEqual(parsed, [
    {
      platform: 'apple',
      id: 'vision-udid-1',
      name: 'Apple Vision Pro',
      kind: 'device',
      target: 'mobile',
      appleOs: 'visionos',
      booted: true,
    },
  ]);
});

test('parseXctracePhysicalAppleDevices parses the parenthesized physical device format', () => {
  const parsed = parseXctracePhysicalAppleDevices(
    [
      '== Devices ==',
      'iPhone 8 Plus (16.7.16) (00008020-001C2D2234567890)',
      'Studio iPad Pro (17.0) (ipad-udid-1)',
      'Living Room Apple TV (16.0) (tv-udid-1)',
    ].join('\n'),
  );

  assert.deepEqual(parsed, [
    {
      platform: 'apple',
      id: '00008020-001C2D2234567890',
      name: 'iPhone 8 Plus',
      kind: 'device',
      target: 'mobile',
      appleOs: 'ios',
      booted: true,
    },
    {
      platform: 'apple',
      id: 'ipad-udid-1',
      name: 'Studio iPad Pro',
      kind: 'device',
      target: 'mobile',
      appleOs: 'ipados',
      booted: true,
    },
    {
      platform: 'apple',
      id: 'tv-udid-1',
      name: 'Living Room Apple TV',
      kind: 'device',
      target: 'tv',
      appleOs: 'tvos',
      booted: true,
    },
  ]);
});

test('parseXctracePhysicalAppleDevices preserves parentheses in bracket-format names', () => {
  const parsed = parseXctracePhysicalAppleDevices(
    ['== Devices ==', "Alex's (iPhone) [alex-udid]", 'Office iPhone (2) [office-udid]'].join('\n'),
  );

  assert.deepEqual(parsed, [
    {
      platform: 'apple',
      id: 'alex-udid',
      name: "Alex's (iPhone)",
      kind: 'device',
      target: 'mobile',
      appleOs: 'ios',
      booted: true,
    },
    {
      platform: 'apple',
      id: 'office-udid',
      name: 'Office iPhone (2)',
      kind: 'device',
      target: 'mobile',
      appleOs: 'ios',
      booted: true,
    },
  ]);
});

test('listAppleDevices tags devicectl iPad product types as iPadOS', async () => {
  mockRunCommand = async (_cmd, args) => {
    if (args.join(' ') === 'simctl list devices -j') {
      return { stdout: createSimctlDevicesPayload(), stderr: '', exitCode: 0 };
    }

    if (args[0] === 'devicectl' && args[1] === 'list' && args[2] === 'devices') {
      const jsonPath = String(args[4]);
      await fs.writeFile(
        jsonPath,
        JSON.stringify({
          result: {
            devices: [
              {
                name: 'Field iPad',
                hardwareProperties: { platform: 'iOS', udid: 'ipad-1', productType: 'iPad14,3' },
              },
            ],
          },
        }),
        'utf8',
      );
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (args.join(' ') === 'xctrace list devices') {
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    throw new Error(`unexpected xcrun args: ${args.join(' ')}`);
  };

  const devices = await withMockedPlatform(
    'darwin',
    async () => await withMockedAppleTools(async () => await listAppleDevices()),
  );

  const iPad = devices.find((device) => device.id === 'ipad-1');
  assert.equal(iPad?.target, 'mobile');
  assert.equal(iPad?.appleOs, 'ipados');
});

test('listAppleDevices tags iPhone simulators and the host Mac with appleOs', async () => {
  mockRunCommand = async (_cmd, args) => {
    if (args.includes('simctl') && args.includes('list') && args.includes('devices')) {
      return {
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
              { name: 'iPhone 16', udid: 'sim-iphone', state: 'Booted', isAvailable: true },
              {
                name: 'iPad Pro 11-inch (M4)',
                udid: 'sim-ipad',
                state: 'Shutdown',
                isAvailable: true,
              },
            ],
            'com.apple.CoreSimulator.SimRuntime.tvOS-18-0': [
              { name: 'Apple TV 4K', udid: 'sim-tv', state: 'Shutdown', isAvailable: true },
            ],
          },
        }),
        stderr: '',
        exitCode: 0,
      };
    }
    throw new Error(`unexpected xcrun args: ${args.join(' ')}`);
  };

  const devices = await withMockedPlatform(
    'darwin',
    async () =>
      await withMockedAppleTools(
        async () => await listAppleDevices({ simulatorSetPath: '/tmp/agent-device-sim-set' }),
      ),
  );

  const byId = new Map(devices.map((device) => [device.id, device.appleOs]));
  assert.equal(byId.get('sim-iphone'), 'ios');
  assert.equal(byId.get('sim-ipad'), 'ipados');
  assert.equal(byId.get('sim-tv'), 'tvos');
  assert.equal(byId.get('host-macos-local'), 'macos');
});

test('listAppleDevices tags visionOS simulators', async () => {
  mockRunCommand = async (_cmd, args) => {
    if (args.includes('simctl') && args.includes('list') && args.includes('devices')) {
      return {
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.xrOS-26-2': [
              {
                name: 'Apple Vision Pro',
                udid: 'sim-vision',
                state: 'Shutdown',
                isAvailable: true,
                deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.Apple-Vision-Pro-4K',
              },
            ],
          },
        }),
        stderr: '',
        exitCode: 0,
      };
    }
    throw new Error(`unexpected xcrun args: ${args.join(' ')}`);
  };

  const devices = await withMockedPlatform(
    'darwin',
    async () =>
      await withMockedAppleTools(
        async () => await listAppleDevices({ simulatorSetPath: '/tmp/agent-device-sim-set' }),
      ),
  );

  const vision = devices.find((device) => device.id === 'sim-vision');
  assert.equal(vision?.target, 'mobile');
  assert.equal(vision?.appleOs, 'visionos');
});

test('listAppleDevices tags renamed iPad simulators as iPadOS from deviceTypeIdentifier', async () => {
  mockRunCommand = async (_cmd, args) => {
    if (args.includes('simctl') && args.includes('list') && args.includes('devices')) {
      return {
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
              {
                // Display name no longer mentions "iPad" (user-renamed), so the
                // classification must come from deviceTypeIdentifier.
                name: 'Work Tablet',
                udid: 'sim-renamed-ipad',
                state: 'Shutdown',
                isAvailable: true,
                deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M4',
              },
            ],
          },
        }),
        stderr: '',
        exitCode: 0,
      };
    }
    throw new Error(`unexpected xcrun args: ${args.join(' ')}`);
  };

  const devices = await withMockedPlatform(
    'darwin',
    async () =>
      await withMockedAppleTools(
        async () => await listAppleDevices({ simulatorSetPath: '/tmp/agent-device-sim-set' }),
      ),
  );

  const ipad = devices.find((device) => device.id === 'sim-renamed-ipad');
  assert.equal(ipad?.target, 'mobile');
  assert.equal(ipad?.appleOs, 'ipados');
});

test('listAppleDevices supplements unsupported devicectl entries with xctrace physical devices', async () => {
  mockRunCommand = async (_cmd, args) => {
    if (args.join(' ') === 'simctl list devices -j') {
      return { stdout: createSimctlDevicesPayload(), stderr: '', exitCode: 0 };
    }

    if (args[0] === 'devicectl' && args[1] === 'list' && args[2] === 'devices') {
      const jsonPath = String(args[4]);
      await fs.writeFile(
        jsonPath,
        JSON.stringify({
          result: {
            devices: [
              {
                identifier: 'legacy-ecid',
                connectionProperties: { tunnelState: 'unavailable' },
                deviceProperties: { bootState: 'booted' },
              },
            ],
          },
        }),
        'utf8',
      );
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (args.join(' ') === 'xctrace list devices') {
      return {
        stdout: ['== Devices ==', 'My iPhone X [00008020-001C2D2234567890]'].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    }

    throw new Error(`unexpected xcrun args: ${args.join(' ')}`);
  };

  const devices = await withMockedPlatform(
    'darwin',
    async () => await withMockedAppleTools(async () => await listAppleDevices()),
  );

  assert.equal(
    devices.some((device) => device.kind === 'device' && device.id === '00008020-001C2D2234567890'),
    true,
  );
  assert.equal(
    devices.some((device) => device.id === 'host-macos-local'),
    true,
  );
  assert.equal(
    devices.some((device) => device.kind === 'simulator' && device.id === 'sim-1'),
    true,
  );
});

test('listAppleDevices prefers devicectl metadata when xctrace reports the same physical device', async () => {
  mockRunCommand = async (_cmd, args) => {
    if (args.join(' ') === 'simctl list devices -j') {
      return { stdout: createSimctlDevicesPayload(), stderr: '', exitCode: 0 };
    }

    if (args[0] === 'devicectl' && args[1] === 'list' && args[2] === 'devices') {
      const jsonPath = String(args[4]);
      await fs.writeFile(
        jsonPath,
        JSON.stringify({
          result: {
            devices: [
              {
                name: 'Primary Name',
                hardwareProperties: {
                  platform: 'iOS',
                  udid: '00008020-001C2D2234567890',
                  productType: 'iPhone16,2',
                },
              },
            ],
          },
        }),
        'utf8',
      );
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (args.join(' ') === 'xctrace list devices') {
      return {
        stdout: ['== Devices ==', 'Fallback Name [00008020-001C2D2234567890]'].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    }

    throw new Error(`unexpected xcrun args: ${args.join(' ')}`);
  };

  const devices = await withMockedPlatform(
    'darwin',
    async () => await withMockedAppleTools(async () => await listAppleDevices()),
  );
  const physicalDevices = devices.filter(
    (device) => device.kind === 'device' && isIosFamily(device),
  );

  assert.equal(physicalDevices.length, 1);
  assert.equal(physicalDevices[0]?.name, 'Primary Name');
});

test('listAppleDevices falls back to xctrace parenthesized devices when devicectl reports none', async () => {
  mockRunCommand = async (_cmd, args) => {
    if (args.join(' ') === 'simctl list devices -j') {
      return { stdout: createSimctlDevicesPayload(), stderr: '', exitCode: 0 };
    }

    if (args[0] === 'devicectl' && args[1] === 'list' && args[2] === 'devices') {
      const jsonPath = String(args[4]);
      await fs.writeFile(jsonPath, JSON.stringify({ result: { devices: [] } }), 'utf8');
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (args.join(' ') === 'xctrace list devices') {
      return {
        stdout: ['== Devices ==', 'iPhone 8 Plus (16.7.16) (00008020-001C2D2234567890)'].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    }

    throw new Error(`unexpected xcrun args: ${args.join(' ')}`);
  };

  const devices = await withMockedPlatform(
    'darwin',
    async () => await withMockedAppleTools(async () => await listAppleDevices()),
  );

  const physicalDevices = devices.filter(
    (device) => device.kind === 'device' && isIosFamily(device),
  );

  assert.equal(physicalDevices.length, 1);
  assert.equal(physicalDevices[0]?.id, '00008020-001C2D2234567890');
  assert.equal(physicalDevices[0]?.name, 'iPhone 8 Plus');
});

test('listAppleDevices keeps physical discovery disabled for simulator-set scoped runs', async () => {
  mockRunCommand = async (_cmd, args) => {
    if (args.includes('simctl') && args.includes('list') && args.includes('devices')) {
      return { stdout: createSimctlDevicesPayload(), stderr: '', exitCode: 0 };
    }

    throw new Error(`unexpected xcrun args: ${args.join(' ')}`);
  };

  const devices = await withMockedPlatform(
    'darwin',
    async () =>
      await withMockedAppleTools(
        async () => await listAppleDevices({ simulatorSetPath: '/tmp/agent-device-sim-set' }),
      ),
  );

  assert.equal(
    devices.some((device) => device.id === 'host-macos-local'),
    true,
  );
  assert.equal(
    devices.some((device) => device.kind === 'device' && isIosFamily(device)),
    false,
  );
  assert.equal(
    toolCalls.some(([, args]) => args.includes('devicectl') || args.includes('xctrace')),
    false,
  );
});

test('listAppleDevices skips physical discovery when explicit udid matches a simulator', async () => {
  mockRunCommand = async (_cmd, args) => {
    if (args.join(' ') === 'simctl list devices -j') {
      return { stdout: createSimctlDevicesPayload(), stderr: '', exitCode: 0 };
    }

    throw new Error(`unexpected xcrun args: ${args.join(' ')}`);
  };

  const devices = await withMockedPlatform(
    'darwin',
    async () => await withMockedAppleTools(async () => await listAppleDevices({ udid: 'sim-1' })),
  );

  assert.equal(
    devices.some((device) => device.kind === 'simulator' && device.id === 'sim-1'),
    true,
  );
  assert.equal(
    toolCalls.some(([, args]) => args.includes('devicectl') || args.includes('xctrace')),
    false,
  );
});

test('listAppleDevices keeps physical discovery when explicit udid is not a simulator', async () => {
  mockRunCommand = async (_cmd, args) => {
    if (args.join(' ') === 'simctl list devices -j') {
      return { stdout: createSimctlDevicesPayload(), stderr: '', exitCode: 0 };
    }

    if (args[0] === 'devicectl' && args[1] === 'list' && args[2] === 'devices') {
      const jsonPath = String(args[4]);
      await fs.writeFile(jsonPath, JSON.stringify({ result: { devices: [] } }), 'utf8');
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (args.join(' ') === 'xctrace list devices') {
      return {
        stdout: ['== Devices ==', 'My iPhone [physical-1]'].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    }

    throw new Error(`unexpected xcrun args: ${args.join(' ')}`);
  };

  const devices = await withMockedPlatform(
    'darwin',
    async () =>
      await withMockedAppleTools(async () => await listAppleDevices({ udid: 'physical-1' })),
  );

  assert.equal(
    devices.some((device) => device.kind === 'device' && device.id === 'physical-1'),
    true,
  );
  assert.equal(
    toolCalls.some(([, args]) => args.includes('xctrace')),
    true,
  );
});

async function withMockedAppleTools<T>(fn: () => Promise<T>): Promise<T> {
  return await withAppleToolProvider(
    createLocalAppleToolProvider({
      whichCommand: async (cmd) => await mockWhichCommand(cmd),
      runCommand: async (cmd, args) => {
        toolCalls.push([cmd, args]);
        return await mockRunCommand(cmd, args);
      },
    }),
    fn,
  );
}
