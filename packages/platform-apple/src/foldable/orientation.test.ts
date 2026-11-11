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
import { readFoldablePanelTable } from './orientation.ts';
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

/**
 * A scoped-set Duo as measured on the device: the guest does not treat the
 * `orientation-picker-control` value as absolute. Each picker event rotates the lit panel by
 * (new value - previous picker value), so the lit panel reads `picker + K` for a fixed
 * per-panel offset K. Angles follow CADisplay `rotN`: portrait 0, landscape-right 90,
 * portrait-upside-down 180, landscape-left 270. The dark panel reports a misleading rotation:
 * only the lit panel's `currentOrientation` may confirm a rotation.
 */
const PANEL_ANGLE: Record<DeviceRotation, number> = {
  portrait: 0,
  'landscape-right': 90,
  'portrait-upside-down': 180,
  'landscape-left': 270,
};

function fakeScopedDuo(
  device: DeviceInfo,
  options: {
    lit: 'inner' | 'outer';
    picker: DeviceRotation;
    offsets: { inner: number; outer: number };
    followsHid?: boolean;
  },
) {
  const helpers: string[][] = [];
  const devicectl: string[] = [];
  let pickerAngle = PANEL_ANGLE[options.picker];
  let litScreenAngle = (pickerAngle + options.offsets[options.lit]) % 360;
  const panel = (kind: 'inner' | 'outer') => {
    const lit = kind === options.lit;
    return {
      backlightState: lit ? 'activeOn' : 'off',
      currentOrientation: lit ? `rot${litScreenAngle}` : 'rot180',
      displayId: kind === 'outer' ? 1 : 3,
      name: kind === 'outer' ? 'LCD' : 'LCD-1',
      nativeSize: kind === 'outer' ? [1398, 2034] : [2007, 2853],
      pointScale: 3,
      primary: kind === 'outer',
      type: { integrated: {} },
    };
  };
  const provider = createLocalAppleToolProvider({
    runCommand: async (_command, args) => {
      const [tool, ...rest] = args;
      if (tool !== 'simctl') {
        devicectl.push(args.join(' '));
        throw new Error(`unexpected tool call in a scoped set: ${args.join(' ')}`);
      }
      const spawn = rest.slice(rest.indexOf('spawn'));
      expect(spawn.slice(0, 3)).toEqual(['spawn', device.id, '/cache/fold-helper']);
      const mode = spawn.slice(3);
      helpers.push(mode);
      if (mode[0] === 'panels') {
        const displays = [panel('outer'), panel('inner')];
        return { stdout: JSON.stringify({ version: 1, displays }), stderr: '', exitCode: 0 };
      }
      expect(mode[0]).toBe('rotate');
      if (options.followsHid !== false) {
        const nextPickerAngle = PANEL_ANGLE[mode[1]! as DeviceRotation];
        litScreenAngle = (litScreenAngle + nextPickerAngle - pickerAngle + 360) % 360;
        pickerAngle = nextPickerAngle;
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  return {
    helpers,
    devicectl,
    rotations: () => helpers.filter((mode) => mode[0] === 'rotate').map((mode) => mode[1]!),
    litScreen: () => `rot${litScreenAngle}`,
    rotate: (rotation: DeviceRotation) =>
      withAppleToolProvider(provider, () =>
        createAppleInteractor(device, {}, createLiveTestHostEnvironment()).setOrientation(rotation),
      ),
  };
}

/** Runs one scoped rotation under fake timers: the settle delay must not cost real time. */
async function rotateScoped(
  sim: ReturnType<typeof fakeScopedDuo>,
  rotation: DeviceRotation,
): Promise<unknown> {
  vi.useFakeTimers();
  try {
    const outcome = sim.rotate(rotation).then(
      (value) => value,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    return await outcome;
  } finally {
    vi.useRealTimers();
  }
}

test('a foldable simulator in a scoped set rotates on the first command, confirmed by the panel table', async () => {
  const scoped = simulator({ simulatorSetPath: '/tmp/scoped-set' });
  // The inner panel lights at rot90 while the picker sits at portrait (K = +90, measured).
  const sim = fakeScopedDuo(scoped, {
    lit: 'inner',
    picker: 'portrait',
    offsets: { inner: 90, outer: 0 },
  });
  expect(sim.litScreen()).toBe('rot90');
  await expect(rotateScoped(sim, 'portrait')).resolves.toEqual({ orientation: 'portrait' });
  expect(sim.litScreen()).toBe('rot0');
  expect(sim.rotations().length).toBeLessThanOrEqual(2);
  expect(sim.devicectl).toEqual([]);
  expect(mockRunner).not.toHaveBeenCalled();
});

test('a scoped rotation to landscape-left dispatches the upside-down picker value when the delta needs it', async () => {
  const scoped = simulator({ simulatorSetPath: '/tmp/scoped-set' });
  const sim = fakeScopedDuo(scoped, {
    lit: 'inner',
    picker: 'landscape-left',
    offsets: { inner: 90, outer: 0 },
  });
  expect(sim.litScreen()).toBe('rot0');
  await expect(rotateScoped(sim, 'landscape-left')).resolves.toEqual({
    orientation: 'landscape-left',
  });
  expect(sim.litScreen()).toBe('rot270');
  expect(sim.rotations()).toContain('portrait-upside-down');
  expect(sim.devicectl).toEqual([]);
});

test('a scoped rotation on the outer panel converges with that panel offset', async () => {
  const scoped = simulator({ simulatorSetPath: '/tmp/scoped-set' });
  const sim = fakeScopedDuo(scoped, {
    lit: 'outer',
    picker: 'portrait',
    offsets: { inner: 90, outer: 270 },
  });
  await expect(rotateScoped(sim, 'landscape-right')).resolves.toEqual({
    orientation: 'landscape-right',
  });
  expect(sim.litScreen()).toBe('rot90');
  expect(sim.rotations().length).toBeLessThanOrEqual(2);
  expect(sim.devicectl).toEqual([]);
});

test('a scoped rotation to the orientation already showing dispatches nothing', async () => {
  const scoped = simulator({ simulatorSetPath: '/tmp/scoped-set' });
  const sim = fakeScopedDuo(scoped, {
    lit: 'inner',
    picker: 'landscape-left',
    offsets: { inner: 90, outer: 0 },
  });
  expect(sim.litScreen()).toBe('rot0');
  await expect(rotateScoped(sim, 'portrait')).resolves.toEqual({ orientation: 'portrait' });
  expect(sim.rotations()).toEqual([]);
});

test('a scoped rotation the panel table never reports is refused as unverified', async () => {
  const scoped = simulator({ simulatorSetPath: '/tmp/scoped-set' });
  const sim = fakeScopedDuo(scoped, {
    lit: 'inner',
    picker: 'portrait',
    offsets: { inner: 90, outer: 0 },
    followsHid: false,
  });
  await expect(rotateScoped(sim, 'portrait')).resolves.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'orientation-unverified-scoped-set', requestedOrientation: 'portrait' },
  });
  expect(sim.devicectl).toEqual([]);
});

test('a foldable simulator in a scoped set still refuses portrait-upside-down as a target', async () => {
  const scoped = simulator({ simulatorSetPath: '/tmp/scoped-set' });
  const sim = fakeScopedDuo(scoped, {
    lit: 'inner',
    picker: 'portrait',
    offsets: { inner: 90, outer: 0 },
  });
  await expect(sim.rotate('portrait-upside-down')).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'unsupported-foldable-orientation' },
  });
  expect(sim.rotations()).toEqual([]);
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

/** A rotation reads the panel table itself: the surface probe's retry window never holds it. */
test('a rotation is not routed by a pending panel-table retry', async () => {
  const device = simulator();
  let tableFailures = 0;
  const sim = fakeSimulator(device, DUO_DISPLAYS);
  const failing = createLocalAppleToolProvider({
    runCommand: async (_command, args) => {
      if (args.slice(0, 4).join(' ') === 'devicectl device info displays') {
        tableFailures += 1;
        throw new AppError('COMMAND_FAILED', 'devicectl does not report displays', {
          timeoutMs: 2_000,
        });
      }
      throw new Error(`unexpected tool call: ${args.join(' ')}`);
    },
  });
  await withAppleToolProvider(failing, () => readFoldablePanelTable(device, { timeoutMs: 5_000 }));
  expect(tableFailures).toBe(1);

  await expect(sim.rotate('landscape-left')).resolves.toEqual({ orientation: 'landscape-left' });
  expect(sim.helpers).toEqual([['rotate', 'landscape-left']]);
  expect(mockRunner).not.toHaveBeenCalled();
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
