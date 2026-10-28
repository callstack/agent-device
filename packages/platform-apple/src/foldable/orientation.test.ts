import fs from 'node:fs';
import { beforeEach, expect, test, vi } from 'vitest';
import { bindTestCommandHost, createLiveTestHostEnvironment } from '@agent-device/test-kit';

vi.mock('./fold-helper-cache.ts', () => ({
  ensureFoldHelperBinary: vi.fn(async () => ({ path: '/cache/fold-helper' })),
}));
vi.mock('../core/runner-client.ts', () => ({
  runAppleRunnerCommand: vi.fn(async () => ({ orientation: 'landscape-left' })),
}));

import type { DeviceRotation } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { runAppleRunnerCommand } from '../core/runner-client.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../core/tool-provider.ts';
import { createAppleInteractor } from '../interactor.ts';
import { IOS_DEVICE, IOS_SIMULATOR } from '../__tests__/device-fixtures.ts';
import { IPHONE_17_SINGLE_PANEL, IPHONE_DUO_CLOSED } from '../__tests__/display-fixtures.ts';

bindTestCommandHost();

const mockRunner = vi.mocked(runAppleRunnerCommand);

beforeEach(() => {
  mockRunner.mockClear();
});

/** A fresh simulator id per test: the daemon keeps each simulator's resolved panel count. */
let simulatorCount = 0;
function simulator(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  simulatorCount += 1;
  return { ...IOS_SIMULATOR, id: `${IOS_SIMULATOR.id}-${simulatorCount}`, ...overrides };
}

const DUO_DISPLAYS = IPHONE_DUO_CLOSED.result.displays;
const SINGLE_PANEL_DISPLAYS = IPHONE_17_SINGLE_PANEL.result.displays;

const CORE_DEVICE_NAMES: Record<string, string> = {
  'landscape-left': 'landscapeLeft',
  'landscape-right': 'landscapeRight',
  portrait: 'portrait',
};

/**
 * A simulator as CoreDevice and simctl see it. A guest HID orientation event takes effect at once
 * unless `followsHid` is false. As measured on iPhone Duo, `devicectl device orientation get`
 * answers with the orientation it sampled at the previous query, starting from `sampled`. The
 * first `wedgedReads` orientation reads time out. The fold helper's `panels` mode serves the
 * displays of a simulator in a scoped set.
 */
function fakeSimulator(
  device: DeviceInfo,
  displays: readonly object[],
  options: { followsHid?: boolean; sampled?: string; wedgedReads?: number } = {},
) {
  const helpers: string[][] = [];
  const devicectl: string[] = [];
  let orientation = 'portrait';
  let sampled = options.sampled ?? orientation;
  let wedgedReads = options.wedgedReads ?? 0;
  const provider = createLocalAppleToolProvider({
    runCommand: async (_command, args) => {
      const [tool, ...rest] = args;
      if (tool === 'simctl') {
        const spawn = rest.slice(rest.indexOf('spawn'));
        expect(spawn.slice(0, 3)).toEqual(['spawn', device.id, '/cache/fold-helper']);
        const mode = spawn.slice(3);
        helpers.push(mode);
        if (mode[0] === 'panels') {
          return { stdout: JSON.stringify({ version: 1, displays }), stderr: '', exitCode: 0 };
        }
        expect(mode[0]).toBe('rotate');
        if (options.followsHid !== false) orientation = CORE_DEVICE_NAMES[mode[1]!]!;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      const jsonPath = args.at(-1)!;
      const query = args.slice(0, 4).join(' ');
      expect(args.slice(4)).toEqual(['--device', device.id, '--json-output', jsonPath]);
      devicectl.push(query);
      if (query === 'devicectl device info displays') {
        fs.writeFileSync(jsonPath, JSON.stringify({ result: { displays } }));
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      expect(query).toBe('devicectl device orientation get');
      if (wedgedReads > 0) {
        wedgedReads -= 1;
        throw new AppError('COMMAND_FAILED', 'xcrun timed out', { timeoutMs: 2_000 });
      }
      fs.writeFileSync(jsonPath, JSON.stringify({ result: { deviceOrientation: sampled } }));
      sampled = orientation;
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  return {
    helpers,
    devicectl,
    rotate: (rotation: DeviceRotation) =>
      withAppleToolProvider(provider, () =>
        createAppleInteractor(device, {}, createLiveTestHostEnvironment()).setOrientation(rotation),
      ),
  };
}

test.each(['landscape-left', 'portrait', 'landscape-right'] as const)(
  'a foldable simulator rotates to %s through guest HID once CoreDevice reports it',
  async (rotation) => {
    const device = simulator();
    const sim = fakeSimulator(device, DUO_DISPLAYS, {
      sampled: rotation === 'portrait' ? 'landscapeLeft' : 'portrait',
    });
    await expect(sim.rotate(rotation)).resolves.toEqual({ orientation: rotation });
    expect(sim.helpers).toEqual([['rotate', rotation]]);
    // The routing probe, the read that can be stale, and the read that reports the rotation.
    expect(sim.devicectl).toEqual([
      'devicectl device info displays',
      'devicectl device orientation get',
      'devicectl device orientation get',
    ]);
    expect(mockRunner).not.toHaveBeenCalled();
  },
);

test('a simulator is probed for its panels once', async () => {
  const sim = fakeSimulator(simulator(), DUO_DISPLAYS);
  await sim.rotate('landscape-left');
  await sim.rotate('portrait');
  expect(sim.devicectl.filter((query) => query.endsWith('displays'))).toHaveLength(1);
  expect(sim.helpers).toEqual([
    ['rotate', 'landscape-left'],
    ['rotate', 'portrait'],
  ]);
});

test('a single-panel simulator keeps the runner rotation', async () => {
  const device = simulator();
  const sim = fakeSimulator(device, SINGLE_PANEL_DISPLAYS);
  await expect(sim.rotate('landscape-left')).resolves.toEqual({ orientation: 'landscape-left' });
  expect(sim.helpers).toEqual([]);
  expect(mockRunner).toHaveBeenCalledWith(
    device,
    expect.objectContaining({ command: 'rotate', orientation: 'landscape-left' }),
    expect.anything(),
  );
});

test('a physical device keeps the runner rotation without a CoreDevice probe', async () => {
  const sim = fakeSimulator(IOS_DEVICE, DUO_DISPLAYS);
  await expect(sim.rotate('landscape-left')).resolves.toEqual({ orientation: 'landscape-left' });
  expect(sim.devicectl).toEqual([]);
  expect(mockRunner).toHaveBeenCalledTimes(1);
});

test('a foldable simulator in a scoped set refuses rotation before any HID dispatch', async () => {
  const scoped = simulator({ simulatorSetPath: '/tmp/scoped-set' });
  const sim = fakeSimulator(scoped, DUO_DISPLAYS);
  await expect(sim.rotate('landscape-left')).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'unsupported-device-scope' },
  });
  expect(sim.helpers).toEqual([['panels']]);
  expect(sim.devicectl).toEqual([]);
  expect(mockRunner).not.toHaveBeenCalled();
});

test('a single-panel simulator in a scoped set keeps the runner rotation', async () => {
  const sim = fakeSimulator(
    simulator({ simulatorSetPath: '/tmp/scoped-set' }),
    SINGLE_PANEL_DISPLAYS,
  );
  await expect(sim.rotate('landscape-left')).resolves.toEqual({ orientation: 'landscape-left' });
  expect(mockRunner).toHaveBeenCalledTimes(1);
});

test('a foldable simulator refuses portrait-upside-down before any HID dispatch', async () => {
  const sim = fakeSimulator(simulator(), DUO_DISPLAYS);
  await expect(sim.rotate('portrait-upside-down')).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'unsupported-foldable-orientation' },
  });
  expect(sim.helpers).toEqual([]);
  expect(mockRunner).not.toHaveBeenCalled();
});

test('a timed-out CoreDevice read does not refuse a rotation that a later read reports', async () => {
  const sim = fakeSimulator(simulator(), DUO_DISPLAYS, { wedgedReads: 2 });
  await expect(sim.rotate('landscape-left')).resolves.toEqual({ orientation: 'landscape-left' });
});

test('a foldable rotation that CoreDevice never reports is refused as unverified', async () => {
  const sim = fakeSimulator(simulator(), DUO_DISPLAYS, { followsHid: false });
  await expect(sim.rotate('landscape-right')).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: {
      reason: 'orientation-unverified',
      requestedOrientation: 'landscape-right',
      observedOrientation: 'portrait',
    },
  });
  expect(sim.helpers).toHaveLength(1);
});

test('a stale CoreDevice sample cannot verify a rotation that did not happen', async () => {
  const sim = fakeSimulator(simulator(), DUO_DISPLAYS, {
    followsHid: false,
    sampled: 'landscapeLeft',
  });
  await expect(sim.rotate('landscape-left')).rejects.toMatchObject({
    details: { reason: 'orientation-unverified', observedOrientation: 'portrait' },
  });
});
