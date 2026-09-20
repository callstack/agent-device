import { beforeEach, describe, test, vi } from 'vitest';
import assert from 'node:assert/strict';

vi.mock('../simctl.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../simctl.ts')>();
  return {
    ...actual,
    runSimctlForDevice: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
  };
});
vi.mock('../tool-provider.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tool-provider.ts')>();
  return {
    ...actual,
    runXcrun: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
  };
});
vi.mock('@agent-device/host-kit/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/diagnostics')>();
  return { ...actual, emitDiagnostic: vi.fn() };
});
vi.mock('@agent-device/host-kit/host-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/host-file')>();
  return {
    ...actual,
    hostTemporaryDirectory: () => '/tmp',
    readHostTextFile: vi.fn(async () => ''),
    unlinkHostFile: vi.fn(async () => {}),
  };
});

import {
  appleSimulatorDisplayArgvFragment,
  buildInventory,
  parseCoreDeviceDisplays,
  readPanelPower,
  resolveAppleCaptureDisplay,
  type AppleDeviceDisplay,
} from '../display-inventory.ts';
import {
  captureSimulatorScreenshotWithFallback,
  captureSimulatorScreenshotWithRetry,
} from '../screenshot.ts';
import { AppError } from '@agent-device/kernel/errors';
import { runXcrun } from '../tool-provider.ts';
import { readHostTextFile } from '@agent-device/host-kit/host-file';
import { runSimctlForDevice } from '../simctl.ts';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { IOS_TEST_SIMULATOR } from './apple-core-stub-helpers.ts';

const mockRunSimctlForDevice = vi.mocked(runSimctlForDevice);
const mockRunXcrun = vi.mocked(runXcrun);
const mockReadHostTextFile = vi.mocked(readHostTextFile);
const mockEmitDiagnostic = vi.mocked(emitDiagnostic);

/** Verbatim `devicectl device info displays` shape for a closed iPhone Duo. */
const IPHONE_DUO_CLOSED = {
  result: {
    displays: [
      {
        active: true,
        backlightState: 'activeOn',
        bounds: [
          [0, 0],
          [1398, 2034],
        ],
        currentOrientation: 'rot0',
        displayId: 1,
        name: 'LCD',
        nativeOrientation: 'rot0',
        nativeSize: [1398, 2034],
        pointScale: 3,
        primary: true,
        type: { integrated: {} },
        uniqueId: '2C570360-1D02-40A1-BFBF-11197BB1159C',
      },
      {
        active: false,
        backlightState: 'off',
        bounds: [
          [0, 0],
          [2007, 2853],
        ],
        currentOrientation: 'rot90',
        displayId: 3,
        name: 'LCD-1',
        nativeOrientation: 'rot0',
        nativeSize: [2007, 2853],
        pointScale: 3,
        primary: false,
        type: { integrated: {} },
        uniqueId: '162CC14D-0995-4D13-9C83-B609458243C8',
      },
    ],
    orientation: { currentDeviceOrientation: 'portrait' },
  },
};

/** Measured on a real iPhone 17: CoreDevice omits `active` entirely for one panel. */
const IPHONE_17_NO_ACTIVE_KEY = {
  result: {
    displays: [
      {
        backlightState: 'activeOn',
        displayId: 1,
        name: 'LCD',
        nativeSize: [1206, 2622],
        pointScale: 3,
        primary: true,
        type: { integrated: {} },
      },
    ],
  },
};

function duoPanelsWithoutActiveKey() {
  return {
    result: {
      displays: IPHONE_DUO_CLOSED.result.displays.map(({ active: _active, ...entry }) => entry),
    },
  };
}

function displayWith(overrides: Partial<AppleDeviceDisplay>): AppleDeviceDisplay {
  return {
    name: 'LCD',
    displayId: 1,
    power: 'lit',
    primary: true,
    widthPx: 1398,
    heightPx: 2034,
    pointScale: 3,
    currentOrientation: 'rot0',
    integrated: true,
    ...overrides,
  };
}

const outerPanel = displayWith({});
const innerPanel = displayWith({
  name: 'LCD-1',
  displayId: 3,
  power: 'dark',
  primary: false,
  widthPx: 2007,
  heightPx: 2853,
});

describe('readPanelPower', () => {
  test('prefers backlight state because CoreDevice omits `active` on real payloads', () => {
    assert.equal(readPanelPower('activeOn', undefined), 'lit');
    assert.equal(readPanelPower('inactiveOn', undefined), 'lit');
    assert.equal(readPanelPower('activeDimmed', undefined), 'lit');
    assert.equal(readPanelPower('off', true), 'dark');
    assert.equal(readPanelPower('someFutureState', true), 'unknown');
  });

  test('falls back to the active flag only when no backlight state is reported', () => {
    assert.equal(readPanelPower(undefined, true), 'lit');
    assert.equal(readPanelPower(undefined, false), 'dark');
    assert.equal(readPanelPower(undefined, undefined), 'unknown');
  });
});

describe('parseCoreDeviceDisplays', () => {
  test('parses both iPhone Duo panels with the identity simctl --display needs', () => {
    const displays = parseCoreDeviceDisplays(IPHONE_DUO_CLOSED);
    assert.equal(displays.length, 2);
    assert.deepEqual(
      displays.map((display) => [
        display.name,
        display.displayId,
        display.pointScale,
        display.power,
      ]),
      [
        ['LCD', 1, 3, 'lit'],
        ['LCD-1', 3, 3, 'dark'],
      ],
    );
  });

  test('derives a lit panel from a payload that omits the active key', () => {
    const [panel] = parseCoreDeviceDisplays(IPHONE_17_NO_ACTIVE_KEY);
    assert.equal(panel!.power, 'lit');
  });

  test('drops entries missing the identity or geometry a capture depends on', () => {
    const parsed = parseCoreDeviceDisplays({
      result: {
        displays: [
          {
            name: 'LCD',
            displayId: 1,
            nativeSize: [1398, 2034],
            pointScale: 3,
            type: { integrated: {} },
          },
          { name: '', displayId: 2, nativeSize: [100, 100], pointScale: 2 },
          { name: 'NoScale', displayId: 3, nativeSize: [100, 100] },
          { name: 'ZeroSize', displayId: 4, nativeSize: [0, 0], pointScale: 2 },
        ],
      },
    });
    assert.deepEqual(
      parsed.map((display) => display.name),
      ['LCD'],
    );
  });

  test('returns nothing for a payload without a display list', () => {
    assert.deepEqual(parseCoreDeviceDisplays({ result: {} }), []);
    assert.deepEqual(parseCoreDeviceDisplays(undefined), []);
  });
});

describe('buildInventory', () => {
  test('names the lit primary panel of a closed Duo without falling through to simctl', () => {
    const inventory = buildInventory(parseCoreDeviceDisplays(IPHONE_DUO_CLOSED));
    assert.equal(inventory.unresolved, false);
    assert.equal(inventory.multiScreen, true);
    assert.equal(inventory.ambiguous, false);
    assert.deepEqual(
      inventory.displays.map((display) => [display.name, display.primary, display.power]),
      [
        ['LCD', true, 'lit'],
        ['LCD-1', false, 'dark'],
      ],
    );
    assert.equal(inventory.activeDisplay?.name, 'LCD');
  });

  test('still resolves the lit panel when CoreDevice omits the active key', () => {
    const inventory = buildInventory(parseCoreDeviceDisplays(duoPanelsWithoutActiveKey()));
    assert.equal(inventory.multiScreen, true);
    assert.equal(inventory.ambiguous, false);
    assert.equal(inventory.activeDisplay?.name, 'LCD');
  });

  test('captures the inner panel when it is the lit one', () => {
    const inventory = buildInventory([
      { ...outerPanel, power: 'dark' },
      { ...innerPanel, power: 'lit' },
    ]);
    assert.equal(inventory.ambiguous, false);
    assert.equal(inventory.activeDisplay?.name, 'LCD-1');
  });

  test('names the primary panel instead of an implicit capture when power is ambiguous', () => {
    for (const panels of [
      [outerPanel, { ...innerPanel, power: 'lit' as const }].map((display) => ({
        ...display,
        power: 'lit' as const,
      })),
      [{ ...outerPanel, power: 'dark' as const }, innerPanel],
      [
        { ...outerPanel, power: 'unknown' as const },
        { ...innerPanel, power: 'unknown' as const },
      ],
    ]) {
      const inventory = buildInventory(panels);
      assert.equal(inventory.multiScreen, true);
      assert.equal(inventory.ambiguous, true);
      assert.equal(inventory.activeDisplay?.name, 'LCD');
    }
  });

  test('names a capture even when no panel reports primary', () => {
    const inventory = buildInventory([
      { ...outerPanel, primary: false },
      { ...innerPanel, power: 'lit', primary: false },
    ]);
    assert.equal(inventory.multiScreen, true);
    assert.equal(inventory.ambiguous, true);
    // A capture is still named: never the implicit black-producing default.
    assert.ok(inventory.activeDisplay);
  });

  test('keeps choosing the lit panel when a third panel is present', () => {
    const inventory = buildInventory([
      { ...outerPanel, power: 'dark' },
      { ...innerPanel, power: 'lit' },
      displayWith({ name: 'LCD-2', displayId: 5, power: 'dark', primary: false }),
    ]);
    assert.equal(inventory.multiScreen, true);
    assert.equal(inventory.activeDisplay?.name, 'LCD-1');
    assert.equal(inventory.displays.length, 3);
  });

  test('keeps a single-panel device single-screen', () => {
    const inventory = buildInventory(parseCoreDeviceDisplays(IPHONE_17_NO_ACTIVE_KEY));
    assert.equal(inventory.multiScreen, false);
    assert.equal(inventory.ambiguous, false);
    assert.equal(inventory.activeDisplay, undefined);
  });

  test('treats an attached external display as neither a foldable panel nor a capture target', () => {
    const inventory = buildInventory([
      outerPanel,
      displayWith({
        name: 'TVOut',
        displayId: 5,
        power: 'dark',
        primary: false,
        widthPx: 1920,
        heightPx: 1080,
        integrated: false,
      }),
    ]);
    assert.equal(inventory.multiScreen, false);
    // The external display is carried through for reporting but never selected.
    assert.equal(inventory.activeDisplay, undefined);
  });
});

describe('resolveAppleCaptureDisplay', () => {
  beforeEach(() => {
    mockRunXcrun.mockClear();
    mockReadHostTextFile.mockReset();
    mockReadHostTextFile.mockResolvedValue('');
    mockEmitDiagnostic.mockClear();
  });

  test('returns the lit panel for a multi-panel device', async () => {
    mockReadHostTextFile.mockResolvedValue(JSON.stringify(IPHONE_DUO_CLOSED));
    const display = await resolveAppleCaptureDisplay(IOS_TEST_SIMULATOR);
    assert.equal(display?.name, 'LCD');
    assert.equal(mockRunXcrun.mock.calls[0]![0][0], 'devicectl');
  });

  test('still names a panel when panel power is ambiguous', async () => {
    mockReadHostTextFile.mockResolvedValue(
      JSON.stringify({
        result: {
          displays: IPHONE_DUO_CLOSED.result.displays.map((entry) => ({
            ...entry,
            backlightState: 'activeOn',
          })),
        },
      }),
    );
    const display = await resolveAppleCaptureDisplay(IOS_TEST_SIMULATOR);
    assert.equal(display?.name, 'LCD');
  });

  test('keeps the historic argv for a single-panel device', async () => {
    mockReadHostTextFile.mockResolvedValue(JSON.stringify(IPHONE_17_NO_ACTIVE_KEY));
    assert.equal(await resolveAppleCaptureDisplay(IOS_TEST_SIMULATOR), undefined);
  });

  test('keeps the historic argv when CoreDevice cannot be asked', async () => {
    mockRunXcrun.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'The specified device was not found',
    } as Awaited<ReturnType<typeof runXcrun>>);
    assert.equal(await resolveAppleCaptureDisplay(IOS_TEST_SIMULATOR), undefined);
  });

  function unresolvedReason(): string | undefined {
    const call = mockEmitDiagnostic.mock.calls.find(
      ([diagnostic]) => diagnostic.phase === 'apple_display_inventory_unresolved',
    );
    return call?.[0].data?.reason as string | undefined;
  }

  test('reports an exec timeout as a timeout, not as an unreadable payload', async () => {
    mockRunXcrun.mockRejectedValueOnce(
      new AppError('COMMAND_FAILED', 'xcrun timed out after 5000ms', {
        cmd: 'xcrun',
        args: ['devicectl'],
        timeoutMs: 5_000,
      }),
    );
    assert.equal(await resolveAppleCaptureDisplay(IOS_TEST_SIMULATOR), undefined);
    assert.equal(unresolvedReason(), 'probe-timed-out');
  });

  test('blames the payload only when devicectl answered', async () => {
    mockRunXcrun.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    mockReadHostTextFile.mockResolvedValueOnce('{"result": ');
    assert.equal(await resolveAppleCaptureDisplay(IOS_TEST_SIMULATOR), undefined);
    assert.equal(unresolvedReason(), 'unreadable-json');
  });

  test('blames the toolchain when devicectl refused the subcommand', async () => {
    mockRunXcrun.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: "ERROR: Unknown command 'displays'",
    });
    assert.equal(await resolveAppleCaptureDisplay(IOS_TEST_SIMULATOR), undefined);
    assert.equal(unresolvedReason(), 'command-failed');
  });

  test('bounds the probe below the capture it precedes', async () => {
    mockReadHostTextFile.mockResolvedValue(JSON.stringify(IPHONE_17_NO_ACTIVE_KEY));
    await resolveAppleCaptureDisplay(IOS_TEST_SIMULATOR);
    const options = mockRunXcrun.mock.calls[0]![1];
    assert.ok(
      (options?.timeoutMs ?? 0) > 0 && (options?.timeoutMs ?? 0) < 20_000,
      `probe budget must stay below the 20s screenshot deadline, got ${options?.timeoutMs}`,
    );
  });
});

describe('appleSimulatorDisplayArgvFragment', () => {
  test('names the panel for capture commands that share the same implicit default', () => {
    assert.deepEqual(appleSimulatorDisplayArgvFragment(outerPanel), ['--display=LCD']);
    assert.deepEqual(appleSimulatorDisplayArgvFragment(undefined), []);
  });
});

describe('captureSimulatorScreenshotWithRetry display targeting', () => {
  beforeEach(() => {
    mockRunSimctlForDevice.mockClear();
  });

  test('names the lit panel explicitly instead of accepting the black default', async () => {
    await captureSimulatorScreenshotWithRetry(IOS_TEST_SIMULATOR, '/tmp/duo.png', outerPanel);
    assert.equal(mockRunSimctlForDevice.mock.calls.length, 1);
    assert.deepEqual(mockRunSimctlForDevice.mock.calls[0]![1], [
      'io',
      IOS_TEST_SIMULATOR.id,
      'screenshot',
      '--display=LCD',
      '/tmp/duo.png',
    ]);
  });

  test('omits the display flag for a single-panel device', async () => {
    await captureSimulatorScreenshotWithRetry(IOS_TEST_SIMULATOR, '/tmp/duo.png', undefined);
    assert.deepEqual(mockRunSimctlForDevice.mock.calls[0]![1], [
      'io',
      IOS_TEST_SIMULATOR.id,
      'screenshot',
      '/tmp/duo.png',
    ]);
  });
});

describe('captureSimulatorScreenshotWithFallback runner fallback', () => {
  test('never rescales a runner capture with the resolved panel point scale', async () => {
    const densityScales: (AppleDeviceDisplay | undefined)[] = [];
    let runnerCaptures = 0;
    await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/duo.png', {
      skipIosSimulatorBootCheck: true,
      pixelDensity: 2,
      deps: {
        ensureBooted: async () => {},
        resolveCaptureDisplay: async () => outerPanel,
        captureWithRetry: async () => {
          throw new Error('simctl screenshot failed');
        },
        normalizeDensity: async (_device, _path, _density, display) => {
          densityScales.push(display);
        },
        captureWithRunner: async () => {
          runnerCaptures += 1;
        },
        shouldFallbackToRunner: () => true,
      },
    });
    assert.equal(runnerCaptures, 1);
    assert.deepEqual(
      densityScales,
      [undefined],
      'the runner captures XCUIScreen.main, so no resolved panel scale may be applied',
    );
  });
});
