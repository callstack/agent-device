import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../core/tool-provider.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/tool-provider.ts')>();
  return {
    ...actual,
    runXcrun: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
  };
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

import { buildAppleSimulatorRecordVideoArgs } from '../simctl-facade.ts';
import { readHostTextFile } from '@agent-device/host-kit/host-file';
import { runXcrun } from '../core/tool-provider.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';

const mockReadHostTextFile = vi.mocked(readHostTextFile);
const mockRunXcrun = vi.mocked(runXcrun);

/** Measured `devicectl device info displays` shape for a closed iPhone Duo. */
const IPHONE_DUO_CLOSED = JSON.stringify({
  result: {
    displays: [
      {
        active: true,
        backlightState: 'activeOn',
        displayId: 1,
        name: 'LCD',
        nativeSize: [1398, 2034],
        pointScale: 3,
        primary: true,
        type: { integrated: {} },
      },
      {
        active: false,
        backlightState: 'off',
        displayId: 3,
        name: 'LCD-1',
        nativeSize: [2007, 2853],
        pointScale: 3,
        primary: false,
        type: { integrated: {} },
      },
    ],
  },
});

const IPHONE_17_SINGLE_PANEL = JSON.stringify({
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
});

describe('buildAppleSimulatorRecordVideoArgs', () => {
  beforeEach(() => {
    mockReadHostTextFile.mockReset();
    mockReadHostTextFile.mockResolvedValue('');
    mockRunXcrun.mockClear();
  });

  test('names the lit panel instead of recording the dark default', async () => {
    mockReadHostTextFile.mockResolvedValue(IPHONE_DUO_CLOSED);
    expect(await buildAppleSimulatorRecordVideoArgs(IOS_SIMULATOR, '/tmp/duo.mp4')).toEqual([
      'simctl',
      'io',
      IOS_SIMULATOR.id,
      'recordVideo',
      '--display=LCD',
      '/tmp/duo.mp4',
    ]);
  });

  test('keeps the historic argv for a single-panel device', async () => {
    mockReadHostTextFile.mockResolvedValue(IPHONE_17_SINGLE_PANEL);
    expect(await buildAppleSimulatorRecordVideoArgs(IOS_SIMULATOR, '/tmp/rec.mp4')).toEqual([
      'simctl',
      'io',
      IOS_SIMULATOR.id,
      'recordVideo',
      '/tmp/rec.mp4',
    ]);
  });

  test('threads the caller signal into the panel probe', async () => {
    mockReadHostTextFile.mockResolvedValue(IPHONE_17_SINGLE_PANEL);
    const controller = new AbortController();
    await buildAppleSimulatorRecordVideoArgs(IOS_SIMULATOR, '/tmp/rec.mp4', {
      signal: controller.signal,
    });
    const probeCall = mockRunXcrun.mock.calls.find(([args]) => args[0] === 'devicectl');
    expect(probeCall).toBeDefined();
    expect(probeCall![1]?.signal).toBe(controller.signal);
  });
});
