import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../core/display-inventory.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/display-inventory.ts')>();
  return { ...actual, queryAppleDisplayInventory: vi.fn() };
});
vi.mock('../core/hinge-angle.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/hinge-angle.ts')>();
  return { ...actual, readAppleHingeAngle: vi.fn() };
});
vi.mock('../core/simulator.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/simulator.ts')>();
  return { ...actual, openIosSimulatorApp: vi.fn(async () => {}) };
});
vi.mock('../os/macos/helper.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../os/macos/helper.ts')>();
  return { ...actual, runMacOsDeviceHubPoseAction: vi.fn() };
});
vi.mock('@agent-device/host-kit/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/diagnostics')>();
  return { ...actual, emitDiagnostic: vi.fn() };
});

import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  buildInventory,
  queryAppleDisplayInventory,
  type AppleDeviceDisplay,
} from '../core/display-inventory.ts';
import { readAppleHingeAngle } from '../core/hinge-angle.ts';
import { runMacOsDeviceHubPoseAction } from '../os/macos/helper.ts';
import { setAppleFoldPose } from './pose.ts';

const mockInventory = vi.mocked(queryAppleDisplayInventory);
const mockHinge = vi.mocked(readAppleHingeAngle);
const mockPress = vi.mocked(runMacOsDeviceHubPoseAction);

const duo: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: '4F879835-4AB3-4046-B033-5AB769209DD4',
  name: 'iPhone Duo',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

function panel(overrides: Partial<AppleDeviceDisplay>): AppleDeviceDisplay {
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

/** The two Duo panels as CoreDevice reports them, with `lit` naming the panel the pose lights. */
function duoInventory(lit: 'outer' | 'inner') {
  return buildInventory([
    panel({ power: lit === 'outer' ? 'lit' : 'dark' }),
    panel({
      name: 'LCD-1',
      displayId: 3,
      primary: false,
      power: lit === 'inner' ? 'lit' : 'dark',
      widthPx: 2007,
      heightPx: 2853,
      currentOrientation: 'rot90',
    }),
  ]);
}

beforeEach(() => {
  mockInventory.mockReset();
  mockHinge.mockReset();
  mockPress.mockReset();
  mockPress.mockResolvedValue({
    pose: 'open',
    control: 'Open',
    windowTitle: 'iPhone Duo – iOS 27.1',
    reopened: false,
    selected: true,
  });
});

test('presses the Device Hub control for the pose and reports the pose CoreDevice read back', async () => {
  mockInventory
    .mockResolvedValueOnce(duoInventory('outer'))
    .mockResolvedValueOnce(duoInventory('inner'));
  // The first read catches the hinge mid-animation; the verifier polls until it settles.
  mockHinge.mockResolvedValueOnce(95.7).mockResolvedValueOnce(180);

  await expect(setAppleFoldPose(duo, 'open')).resolves.toEqual({
    pose: 'open',
    hingeAngleDegrees: 180,
    screen: { display: 'LCD-1', widthPt: 669, heightPt: 951 },
  });

  expect(mockPress).toHaveBeenCalledWith({
    udid: duo.id,
    deviceName: 'iPhone Duo',
    pose: 'open',
    signal: undefined,
  });
  expect(mockHinge).toHaveBeenCalledTimes(2);
});

test('maps half-open onto the Book preset and reports it only once the hinge has stopped', async () => {
  mockInventory
    .mockResolvedValueOnce(duoInventory('inner'))
    .mockResolvedValueOnce(duoInventory('inner'));
  // A hinge on its way from open to Book sweeps through half-open angles; the live run read 175.1°
  // one stream after the press. Only the repeated 130° is the preset.
  mockHinge.mockResolvedValueOnce(175.1).mockResolvedValueOnce(130).mockResolvedValueOnce(130);

  await expect(setAppleFoldPose(duo, 'half-open')).resolves.toMatchObject({
    pose: 'half-open',
    hingeAngleDegrees: 130,
  });
  expect(mockPress).toHaveBeenCalledWith(expect.objectContaining({ pose: 'book' }));
  expect(mockHinge).toHaveBeenCalledTimes(3);
});

test('refuses half-open when the hinge was observed there but never came to rest', async () => {
  mockInventory.mockResolvedValueOnce(duoInventory('inner'));
  mockHinge
    .mockResolvedValueOnce(170)
    .mockResolvedValueOnce(150)
    .mockResolvedValueOnce(120)
    .mockResolvedValueOnce(90);

  // Every read classifies as half-open, so the requested category was observed; what is missing is
  // a hinge that stopped.
  const failure = await setAppleFoldPose(duo, 'half-open').catch((error: unknown) => error);
  expect(failure).toMatchObject({
    code: 'COMMAND_FAILED',
    details: expect.objectContaining({
      reason: 'fold-pose-unsettled',
      requestedPose: 'half-open',
      observedPose: 'half-open',
      hingeAngleDegrees: 90,
      previousHingeAngleDegrees: 120,
    }),
  });
  // The observed pose refutes a claim that the pose was never reached, so the refusal may only say
  // the hinge did not come to rest inside it.
  expect((failure as Error).message).toContain('did not settle');
  expect((failure as Error).message).not.toContain('did not reach');
  expect(mockHinge).toHaveBeenCalledTimes(4);
  // A refused pose never reaches the capture-path panel read.
  expect(mockInventory).toHaveBeenCalledTimes(1);
});

test('refuses half-open when consecutive readings only straddle the open boundary', async () => {
  mockInventory.mockResolvedValueOnce(duoInventory('inner'));
  // 179° is `open` and 178.8° is `half-open`, yet they differ by 0.2°. Numerical proximity across a
  // category boundary is not two readings of a hinge that came to rest inside the requested pose.
  mockHinge
    .mockResolvedValueOnce(180)
    .mockResolvedValueOnce(180)
    .mockResolvedValueOnce(179)
    .mockResolvedValueOnce(178.8);

  await expect(setAppleFoldPose(duo, 'half-open')).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: expect.objectContaining({
      reason: 'fold-pose-unsettled',
      requestedPose: 'half-open',
      observedPose: 'half-open',
      hingeAngleDegrees: 178.8,
      previousHingeAngleDegrees: 179,
    }),
  });
  expect(mockHinge).toHaveBeenCalledTimes(4);
  expect(mockInventory).toHaveBeenCalledTimes(1);
});

test('refuses half-open as unverified when the last reading is another pose', async () => {
  mockInventory.mockResolvedValueOnce(duoInventory('inner'));
  mockHinge
    .mockResolvedValueOnce(170)
    .mockResolvedValueOnce(150)
    .mockResolvedValueOnce(120)
    .mockResolvedValueOnce(180);

  await expect(setAppleFoldPose(duo, 'half-open')).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: expect.objectContaining({
      reason: 'fold-pose-unverified',
      requestedPose: 'half-open',
      observedPose: 'open',
      hingeAngleDegrees: 180,
    }),
  });
  expect(mockInventory).toHaveBeenCalledTimes(1);
});

test('refuses the pose when the hinge never reaches it, naming what CoreDevice still reports', async () => {
  mockInventory.mockResolvedValueOnce(duoInventory('inner'));
  mockHinge.mockResolvedValue(180);

  await expect(setAppleFoldPose(duo, 'closed')).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: expect.objectContaining({
      reason: 'fold-pose-unverified',
      requestedPose: 'closed',
      observedPose: 'open',
      hingeAngleDegrees: 180,
    }),
  });
  expect(mockHinge).toHaveBeenCalledTimes(4);
});

test('reports closed on one reading at the end stop, without waiting for a second one', async () => {
  mockInventory
    .mockResolvedValueOnce(duoInventory('outer'))
    .mockResolvedValueOnce(duoInventory('outer'));
  // 95.7° is the hinge mid-sweep toward closed; 0.4° is the end stop, and an end stop needs no
  // confirmation. Routing `closed` through the half-open settle rule would want another read.
  mockHinge.mockResolvedValueOnce(95.7).mockResolvedValueOnce(0.4);

  await expect(setAppleFoldPose(duo, 'closed')).resolves.toMatchObject({
    pose: 'closed',
    hingeAngleDegrees: 0.4,
  });
  expect(mockHinge).toHaveBeenCalledTimes(2);
});

test('refuses before reading the hinge at all when the request is already cancelled', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('request cancelled', 'AbortError'));
  mockInventory.mockResolvedValueOnce(duoInventory('inner'));

  await expect(
    setAppleFoldPose(duo, 'half-open', { signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(mockHinge).not.toHaveBeenCalled();
});

test('propagates a cancellation raised by a hinge read and stops polling', async () => {
  const controller = new AbortController();
  mockInventory.mockResolvedValueOnce(duoInventory('inner'));
  mockHinge.mockImplementation(async () => {
    const cancelled = new DOMException('request cancelled', 'AbortError');
    controller.abort(cancelled);
    throw cancelled;
  });

  await expect(
    setAppleFoldPose(duo, 'half-open', { signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(mockHinge).toHaveBeenCalledTimes(1);
});

test('refuses a single-panel simulator before pressing anything', async () => {
  mockInventory.mockResolvedValueOnce(buildInventory([panel({})]));

  await expect(setAppleFoldPose({ ...duo, name: 'iPhone 17' }, 'open')).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: expect.objectContaining({ reason: 'single-panel-device' }),
  });
  expect(mockPress).not.toHaveBeenCalled();
  expect(mockHinge).not.toHaveBeenCalled();
});

test('refuses a physical device and an unreadable display table before pressing anything', async () => {
  await expect(setAppleFoldPose({ ...duo, kind: 'device' }, 'open')).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
  });
  mockInventory.mockResolvedValueOnce({
    displays: [],
    multiScreen: false,
    ambiguous: false,
    unresolved: true,
  });
  await expect(setAppleFoldPose(duo, 'open')).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: expect.objectContaining({ hint: expect.stringContaining('displays') }),
  });
  expect(mockPress).not.toHaveBeenCalled();
});
