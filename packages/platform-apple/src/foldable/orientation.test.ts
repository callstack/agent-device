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
 * A scoped-set Duo as measured on the device (iOS 27.3): the guest keeps one
 * `orientation-picker-control` value, and the lit panel reads that value plus a fixed
 * per-panel offset — outer 0, inner +90 — so successive events look relative on the inner
 * panel. The picker survives a fold: the panel that lights afterwards reads it plus its own
 * offset. A panel whose foreground UI cannot show `picker + offset` keeps the rotation it last
 * showed (measured: after a fold left the picker at the upside-down value, the outer panel kept
 * landscape-left). For `bothLitReads` panel reads after a fold to closed, both panels report
 * lit, as the Duo's table does for a few seconds. Angles follow CADisplay `rotN`: portrait 0,
 * landscape-right 90, portrait-upside-down 180, landscape-left 270. A dark panel reports a
 * misleading rotation: only the lit panel's `currentOrientation` may confirm a rotation.
 */
const PANEL_ANGLE: Record<DeviceRotation, number> = {
  portrait: 0,
  'landscape-right': 90,
  'portrait-upside-down': 180,
  'landscape-left': 270,
};
const MEASURED_OFFSETS = { inner: 90, outer: 0 } as const;

type DuoPanel = 'inner' | 'outer';

function rotationAtAngle(angle: number): DeviceRotation {
  const rotation = (Object.keys(PANEL_ANGLE) as DeviceRotation[]).find(
    (candidate) => PANEL_ANGLE[candidate] === ((angle % 360) + 360) % 360,
  );
  return rotation!;
}

function fakeScopedDuo(
  device: DeviceInfo,
  options: {
    lit: DuoPanel;
    picker: DeviceRotation;
    offsets?: { inner: number; outer: number };
    followsHid?: boolean;
    /** Rotations a panel's foreground UI cannot show; the panel keeps its last rotation. */
    cannotShow?: Partial<Record<DuoPanel, readonly DeviceRotation[]>>;
    /** The rotation a dark panel last showed, for the fold that lights it. */
    lastShown?: Partial<Record<DuoPanel, DeviceRotation>>;
    /** From this panel read on (1-based, the routing probe included), both panels report lit. */
    bothLitFromRead?: number;
    /** How many panel reads after a picker event still show the panel as it was before it. */
    hidLagReads?: number;
  },
) {
  const helpers: string[][] = [];
  const devicectl: string[] = [];
  const offsets = options.offsets ?? MEASURED_OFFSETS;
  let lit = options.lit;
  let pickerAngle = PANEL_ANGLE[options.picker];
  let pendingPicker: number | undefined;
  let lagReadsLeft = 0;
  let bothLitReads = 0;
  let panelReads = 0;
  const shown: Record<DuoPanel, number> = {
    inner: PANEL_ANGLE[options.lastShown?.inner ?? 'portrait'],
    outer: PANEL_ANGLE[options.lastShown?.outer ?? 'portrait'],
  };
  /** The panel shows `picker + offset` unless its foreground UI cannot. */
  const show = (kind: DuoPanel) => {
    const angle = (pickerAngle + offsets[kind]) % 360;
    if (!options.cannotShow?.[kind]?.includes(rotationAtAngle(angle))) shown[kind] = angle;
  };
  show(lit);
  const panel = (kind: DuoPanel, bothLit: boolean) => {
    const isLit = bothLit || kind === lit;
    return {
      backlightState: isLit ? 'activeOn' : 'off',
      currentOrientation: isLit ? `rot${shown[kind]}` : 'rot180',
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
        panelReads += 1;
        if (lagReadsLeft > 0) lagReadsLeft -= 1;
        else if (pendingPicker !== undefined) {
          pickerAngle = pendingPicker;
          pendingPicker = undefined;
          show(lit);
        }
        const bothLit =
          bothLitReads > 0 ||
          (options.bothLitFromRead !== undefined && panelReads >= options.bothLitFromRead);
        if (bothLitReads > 0) bothLitReads -= 1;
        const displays = [panel('outer', bothLit), panel('inner', bothLit)];
        return { stdout: JSON.stringify({ version: 1, displays }), stderr: '', exitCode: 0 };
      }
      expect(mode[0]).toBe('rotate');
      if (options.followsHid !== false && options.hidLagReads) {
        pendingPicker = PANEL_ANGLE[mode[1]! as DeviceRotation];
        lagReadsLeft = options.hidLagReads;
      } else if (options.followsHid !== false) {
        pickerAngle = PANEL_ANGLE[mode[1]! as DeviceRotation];
        show(lit);
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  return {
    helpers,
    devicectl,
    panelReads: () => panelReads,
    rotations: () => helpers.filter((mode) => mode[0] === 'rotate').map((mode) => mode[1]!),
    litScreen: () => `rot${shown[lit]}`,
    /** A pose change made outside the rotation: the picker stays, the other panel lights. */
    fold: (kind: DuoPanel, foldOptions: { bothLitReads?: number } = {}) => {
      lit = kind;
      bothLitReads = foldOptions.bothLitReads ?? 0;
      show(kind);
      helpers.length = 0;
      panelReads = 0;
    },
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
  const sim = fakeScopedDuo(scoped, { lit: 'inner', picker: 'portrait' });
  expect(sim.litScreen()).toBe('rot90');
  await expect(rotateScoped(sim, 'portrait')).resolves.toEqual({ orientation: 'portrait' });
  expect(sim.litScreen()).toBe('rot0');
  // The measured inner offset makes the first dispatch exact: portrait - 90 is landscape-left.
  expect(sim.rotations()).toEqual(['landscape-left']);
  expect(sim.devicectl).toEqual([]);
  expect(mockRunner).not.toHaveBeenCalled();
});

test('a scoped rotation to landscape-left dispatches the upside-down picker value when the delta needs it', async () => {
  const scoped = simulator({ simulatorSetPath: '/tmp/scoped-set' });
  const sim = fakeScopedDuo(scoped, {
    lit: 'inner',
    picker: 'landscape-left',
  });
  expect(sim.litScreen()).toBe('rot0');
  await expect(rotateScoped(sim, 'landscape-left')).resolves.toEqual({
    orientation: 'landscape-left',
  });
  expect(sim.litScreen()).toBe('rot270');
  expect(sim.rotations()).toEqual(['portrait-upside-down']);
  expect(sim.devicectl).toEqual([]);
});

test('the outer panel reads the picker value itself, so its first dispatch is the target', async () => {
  const scoped = simulator({ simulatorSetPath: '/tmp/scoped-set' });
  const sim = fakeScopedDuo(scoped, { lit: 'outer', picker: 'portrait' });
  expect(sim.litScreen()).toBe('rot0');
  for (const rotation of ['landscape-left', 'landscape-right', 'portrait'] as const) {
    sim.helpers.length = 0;
    await expect(rotateScoped(sim, rotation)).resolves.toEqual({ orientation: rotation });
    expect(sim.rotations()).toEqual([rotation]);
  }
  expect(sim.devicectl).toEqual([]);
});

test('a panel whose offset differs from the measured one still converges', async () => {
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
  // The measured outer offset (0) lands a quarter-turn away; that reading calibrates the second.
  expect(sim.rotations()).toEqual(['landscape-right', 'portrait-upside-down']);
  expect(sim.devicectl).toEqual([]);
});

test('the picker survives a fold in both directions and each panel adds its own offset', async () => {
  const scoped = simulator({ simulatorSetPath: '/tmp/scoped-set' });
  // Measured sequence: the inner panel at rot0 with the picker at landscape-left.
  const sim = fakeScopedDuo(scoped, { lit: 'inner', picker: 'landscape-left' });
  expect(sim.litScreen()).toBe('rot0');

  sim.fold('outer');
  expect(sim.litScreen()).toBe('rot270');
  await expect(rotateScoped(sim, 'portrait')).resolves.toEqual({ orientation: 'portrait' });
  expect(sim.rotations()).toEqual(['portrait']);

  sim.fold('inner');
  expect(sim.litScreen()).toBe('rot90');
  await expect(rotateScoped(sim, 'landscape-left')).resolves.toEqual({
    orientation: 'landscape-left',
  });
  expect(sim.rotations()).toEqual(['portrait-upside-down']);
});

test('a fold that leaves the picker where the outer panel cannot follow still lands in one dispatch', async () => {
  const scoped = simulator({ simulatorSetPath: '/tmp/scoped-set' });
  // Measured: the inner panel at landscape-left needs the picker at the upside-down value; the
  // outer panel's foreground UI has no upside-down, so after the fold it kept landscape-left.
  const sim = fakeScopedDuo(scoped, {
    lit: 'inner',
    picker: 'portrait-upside-down',
    cannotShow: { outer: ['portrait-upside-down'] },
    lastShown: { outer: 'landscape-left' },
  });
  expect(sim.litScreen()).toBe('rot270');
  sim.fold('outer');
  expect(sim.litScreen()).toBe('rot270');
  await expect(rotateScoped(sim, 'landscape-right')).resolves.toEqual({
    orientation: 'landscape-right',
  });
  expect(sim.rotations()).toEqual(['landscape-right']);
});

test('reads with both panels lit after a fold to closed neither confirm nor dispatch', async () => {
  const scoped = simulator({ simulatorSetPath: '/tmp/scoped-set' });
  const sim = fakeScopedDuo(scoped, { lit: 'inner', picker: 'landscape-left' });
  // A first command routes the device as a foldable (one panel probe) and finds portrait showing.
  await expect(rotateScoped(sim, 'portrait')).resolves.toEqual({ orientation: 'portrait' });
  // The outer panel already shows the target, but the table names two lit panels for two reads.
  sim.fold('outer', { bothLitReads: 2 });
  expect(sim.litScreen()).toBe('rot270');
  await expect(rotateScoped(sim, 'landscape-left')).resolves.toEqual({
    orientation: 'landscape-left',
  });
  // Confirmed by the third read, the first to name one lit panel; nothing was dispatched blind.
  expect(sim.panelReads()).toBe(3);
  expect(sim.rotations()).toEqual([]);
});

test('after the both-lit reads, the first single-lit reading drives one exact dispatch', async () => {
  const scoped = simulator({ simulatorSetPath: '/tmp/scoped-set' });
  const sim = fakeScopedDuo(scoped, { lit: 'inner', picker: 'landscape-left' });
  await expect(rotateScoped(sim, 'portrait')).resolves.toEqual({ orientation: 'portrait' });
  sim.fold('outer', { bothLitReads: 2 });
  await expect(rotateScoped(sim, 'landscape-right')).resolves.toEqual({
    orientation: 'landscape-right',
  });
  expect(sim.panelReads()).toBe(4);
  expect(sim.rotations()).toEqual(['landscape-right']);
});

test('a table that never names a single lit panel dispatches nothing and is refused', async () => {
  const scoped = simulator({ simulatorSetPath: '/tmp/scoped-set' });
  const sim = fakeScopedDuo(scoped, { lit: 'outer', picker: 'portrait', bothLitFromRead: 1 });
  const outcome = await rotateScoped(sim, 'landscape-left');
  expect(outcome).toMatchObject({
    code: 'COMMAND_FAILED',
    details: {
      reason: 'orientation-unverified-scoped-set',
      requestedOrientation: 'landscape-left',
    },
  });
  expect((outcome as AppError).message).toContain('named no single lit panel');
  expect((outcome as AppError).details).not.toHaveProperty('observedOrientation');
  expect(sim.rotations()).toEqual([]);
});

test('an undecided final read does not report an earlier reading as the current one', async () => {
  const scoped = simulator({ simulatorSetPath: '/tmp/scoped-set' });
  // The routing probe and two decided rotation reads, then both panels report lit to the end.
  const sim = fakeScopedDuo(scoped, {
    lit: 'inner',
    picker: 'portrait',
    followsHid: false,
    bothLitFromRead: 4,
  });
  const outcome = await rotateScoped(sim, 'portrait');
  expect(outcome).toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'orientation-unverified-scoped-set' },
  });
  expect((outcome as AppError).details).not.toHaveProperty('observedOrientation');
  expect((outcome as AppError).details).not.toHaveProperty('rawPanelOrientation');
  expect(sim.rotations()).toEqual(['landscape-left']);
});

test('a scoped rotation to the orientation already showing dispatches nothing', async () => {
  const scoped = simulator({ simulatorSetPath: '/tmp/scoped-set' });
  const sim = fakeScopedDuo(scoped, {
    lit: 'inner',
    picker: 'landscape-left',
  });
  expect(sim.litScreen()).toBe('rot0');
  await expect(rotateScoped(sim, 'portrait')).resolves.toEqual({ orientation: 'portrait' });
  expect(sim.rotations()).toEqual([]);
});

test('a reading taken before the dispatch lands teaches nothing and is not followed by another dispatch', async () => {
  const scoped = simulator({ simulatorSetPath: '/tmp/scoped-set' });
  // The first two panel reads after each picker event still show the panel as it was before it.
  const sim = fakeScopedDuo(scoped, { lit: 'inner', picker: 'portrait', hidLagReads: 2 });
  expect(sim.litScreen()).toBe('rot90');
  await expect(rotateScoped(sim, 'landscape-left')).resolves.toEqual({
    orientation: 'landscape-left',
  });
  // One exact dispatch (landscape-left - 90 = portrait-upside-down); the stale reads in between
  // neither re-learned an offset nor dispatched again.
  expect(sim.rotations()).toEqual(['portrait-upside-down']);
});

test('a scoped rotation the lit panel never shows is refused as unverified', async () => {
  const scoped = simulator({ simulatorSetPath: '/tmp/scoped-set' });
  const sim = fakeScopedDuo(scoped, {
    lit: 'inner',
    picker: 'portrait',
    followsHid: false,
  });
  await expect(rotateScoped(sim, 'portrait')).resolves.toMatchObject({
    code: 'COMMAND_FAILED',
    message: expect.stringContaining('the lit panel shows landscape-right'),
    details: {
      reason: 'orientation-unverified-scoped-set',
      requestedOrientation: 'portrait',
      observedOrientation: 'landscape-right',
      rawPanelOrientation: 'rot90',
    },
  });
  // The panel never moved after the one dispatch, so it taught no offset and nothing more was
  // dispatched: the loop re-read until its budget ended, then refused.
  expect(sim.rotations()).toEqual(['landscape-left']);
  expect(sim.devicectl).toEqual([]);
});

test('a foldable simulator in a scoped set still refuses portrait-upside-down as a target', async () => {
  const scoped = simulator({ simulatorSetPath: '/tmp/scoped-set' });
  const sim = fakeScopedDuo(scoped, {
    lit: 'inner',
    picker: 'portrait',
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
