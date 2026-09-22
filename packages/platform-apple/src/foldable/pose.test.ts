import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../core/display-inventory.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/display-inventory.ts')>();
  return { ...actual, queryAppleDisplayInventory: vi.fn() };
});
vi.mock('../core/hinge-angle.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/hinge-angle.ts')>();
  return { ...actual, readAppleHingeAngle: vi.fn() };
});
vi.mock('./simulator-hid.ts', () => ({ sendSimulatorFoldPose: vi.fn() }));
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
import { sendSimulatorFoldPose } from './simulator-hid.ts';
import { setAppleFoldPose } from './pose.ts';

const mockInventory = vi.mocked(queryAppleDisplayInventory);
const mockHinge = vi.mocked(readAppleHingeAngle);
const mockSend = vi.mocked(sendSimulatorFoldPose);

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
  mockSend.mockReset();
  mockSend.mockResolvedValue(undefined);
});

test('sends the simulator HID pose and reports the pose CoreDevice read back', async () => {
  mockInventory
    .mockResolvedValueOnce(duoInventory('outer'))
    .mockResolvedValueOnce(duoInventory('inner'));
  // The first read catches the hinge mid-animation; the verifier polls until it settles.
  mockHinge.mockResolvedValueOnce(95.7).mockResolvedValueOnce(180);

  await expect(setAppleFoldPose(duo, { pose: 'open' })).resolves.toEqual({
    pose: 'open',
    hingeAngleDegrees: 180,
    screen: { display: 'LCD-1', coordinateSpace: 'native-panel', widthPt: 669, heightPt: 951 },
  });

  expect(mockSend).toHaveBeenCalledWith(duo.id, 'open', undefined);
  expect(mockHinge).toHaveBeenCalledTimes(2);
});

test('reports the closed outer panel in native points, not rotated to a snapshot viewport', async () => {
  // The outer panel is 1398x2034 px at scale 3, i.e. 466x678 native points; the pose must not
  // rotate that into the app window's shape, because a caller cannot place a tap from it.
  mockInventory
    .mockResolvedValueOnce(duoInventory('outer'))
    .mockResolvedValueOnce(duoInventory('outer'));
  mockHinge.mockResolvedValue(0);

  await expect(setAppleFoldPose(duo, { pose: 'closed' })).resolves.toEqual({
    pose: 'closed',
    hingeAngleDegrees: 0,
    screen: { display: 'LCD', coordinateSpace: 'native-panel', widthPt: 466, heightPt: 678 },
  });
});

test("reports native panel points regardless of the display's own currentOrientation", async () => {
  // The same inner panel (2007x2853 px at scale 3) with a portrait orientation tag still measures
  // 669x951: the report divides by point scale only and never swaps on `currentOrientation`.
  const rot0Inner = buildInventory([
    panel({ power: 'dark' }),
    panel({
      name: 'LCD-1',
      displayId: 3,
      primary: false,
      power: 'lit',
      widthPx: 2007,
      heightPx: 2853,
      currentOrientation: 'rot0',
    }),
  ]);
  mockInventory.mockResolvedValueOnce(duoInventory('inner')).mockResolvedValueOnce(rot0Inner);
  mockHinge.mockResolvedValue(180);

  const result = await setAppleFoldPose(duo, { pose: 'open' });
  expect(result.screen).toEqual({
    display: 'LCD-1',
    coordinateSpace: 'native-panel',
    widthPt: 669,
    heightPt: 951,
  });
});

test('omits the screen report when panel selection is ambiguous, never inventing a viewport', async () => {
  // Two lit panels make the inventory ambiguous, so `readLitPanel` refuses to name one; the pose is
  // still verified but carries no `screen` rather than guessing the app viewport.
  const bothLit = buildInventory([panel({}), panel({ name: 'LCD-1', displayId: 3 })]);
  expect(bothLit.ambiguous).toBe(true);
  mockInventory.mockResolvedValueOnce(bothLit).mockResolvedValueOnce(bothLit);
  mockHinge.mockResolvedValue(180);

  await expect(setAppleFoldPose(duo, { pose: 'open' })).resolves.toEqual({
    pose: 'open',
    hingeAngleDegrees: 180,
  });
});

test('sends half-open and reports it only once the hinge has stopped', async () => {
  mockInventory
    .mockResolvedValueOnce(duoInventory('inner'))
    .mockResolvedValueOnce(duoInventory('inner'));
  // A hinge on its way from open to Book sweeps through half-open angles; the live run read 175.1°
  // one stream after the press. Only the repeated 130° is the preset.
  mockHinge.mockResolvedValueOnce(175.1).mockResolvedValueOnce(130).mockResolvedValueOnce(130);

  await expect(setAppleFoldPose(duo, { pose: 'half-open' })).resolves.toMatchObject({
    pose: 'half-open',
    hingeAngleDegrees: 130,
    screen: { display: 'LCD-1', coordinateSpace: 'native-panel', widthPt: 669, heightPt: 951 },
  });
  expect(mockSend).toHaveBeenCalledWith(duo.id, 'half-open', undefined);
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
  const failure = await setAppleFoldPose(duo, { pose: 'half-open' }).catch(
    (error: unknown) => error,
  );
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

  await expect(setAppleFoldPose(duo, { pose: 'half-open' })).rejects.toMatchObject({
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

  await expect(setAppleFoldPose(duo, { pose: 'half-open' })).rejects.toMatchObject({
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

  await expect(setAppleFoldPose(duo, { pose: 'closed' })).rejects.toMatchObject({
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

  await expect(setAppleFoldPose(duo, { pose: 'closed' })).resolves.toMatchObject({
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
    setAppleFoldPose(duo, { pose: 'half-open' }, { signal: controller.signal }),
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
    setAppleFoldPose(duo, { pose: 'half-open' }, { signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(mockHinge).toHaveBeenCalledTimes(1);
});

test('refuses a single-panel simulator before sending anything', async () => {
  mockInventory.mockResolvedValueOnce(buildInventory([panel({})]));

  await expect(
    setAppleFoldPose({ ...duo, name: 'iPhone 17' }, { pose: 'open' }),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: expect.objectContaining({ reason: 'single-panel-device' }),
  });
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockHinge).not.toHaveBeenCalled();
});

test('refuses a physical device and an unreadable display table before sending anything', async () => {
  await expect(
    setAppleFoldPose({ ...duo, kind: 'device' }, { pose: 'open' }),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
  });
  mockInventory.mockResolvedValueOnce({
    displays: [],
    multiScreen: false,
    ambiguous: false,
    unresolved: true,
  });
  await expect(setAppleFoldPose(duo, { pose: 'open' })).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: expect.objectContaining({ hint: expect.stringContaining('displays') }),
  });
  expect(mockSend).not.toHaveBeenCalled();
});

test('a stable half-open angle cannot satisfy a different final keyframe angle', async () => {
  mockInventory.mockResolvedValue(duoInventory('inner'));
  mockHinge.mockResolvedValue(130);
  await expect(
    setAppleFoldPose(duo, {
      keyframes: [
        { atMs: 0, angle: 0 },
        { atMs: 5000, angle: 100 },
      ],
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'fold-angle-unverified', targetAngleDegrees: 100, hingeAngleDegrees: 130 },
  });
});

test('reports a custom final angle only after it reaches and holds that angle', async () => {
  mockInventory.mockResolvedValue(duoInventory('inner'));
  mockHinge.mockResolvedValueOnce(130).mockResolvedValueOnce(100).mockResolvedValueOnce(100);
  const keyframes = [
    { atMs: 0, angle: 0 },
    { atMs: 5000, angle: 100 },
  ];
  await expect(setAppleFoldPose(duo, { keyframes })).resolves.toMatchObject({
    pose: 'half-open',
    hingeAngleDegrees: 100,
  });
  expect(mockSend).toHaveBeenCalledWith(duo.id, keyframes, undefined);
});
