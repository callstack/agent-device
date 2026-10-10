import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../adb.ts', () => ({ runAndroidAdb: vi.fn(), runAndroidShell: vi.fn() }));
vi.mock('@agent-device/host-kit/retry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/retry')>();
  return { ...actual, sleep: vi.fn(async () => {}) };
});
vi.mock('@agent-device/host-kit/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/diagnostics')>();
  return { ...actual, emitDiagnostic: vi.fn() };
});

import { sleep } from '@agent-device/host-kit/retry';

import { runAndroidAdb, runAndroidShell } from '../adb.ts';
import { ANDROID_EMULATOR } from '../runtime.fixtures.ts';
import { setAndroidFoldPose } from './pose.ts';

const mockAdb = vi.mocked(runAndroidAdb);
const mockShell = vi.mocked(runAndroidShell);
const mockSleep = vi.mocked(sleep);

/** `cmd device_state print-states` on a Pixel fold: the posture states are numbered from 0. */
const PIXEL_FOLD_STATES = `Supported states: [
  DeviceState{identifier=0, name='CLOSED', app_accessible=true, cancel_when_requester_not_on_top=false},
  DeviceState{identifier=1, name='HALF_OPENED', app_accessible=true, cancel_when_requester_not_on_top=false},
  DeviceState{identifier=2, name='OPENED', app_accessible=true, cancel_when_requester_not_on_top=false},
  DeviceState{identifier=3, name='REAR_DISPLAY_MODE', app_accessible=true, cancel_when_requester_not_on_top=false},
]
`;
/** The generic "7.6in Foldable" profile numbers the same states from 1. */
const GENERIC_FOLDABLE_STATES = `Supported states: [
  DeviceState{identifier=1, name='CLOSED', app_accessible=true, cancel_when_requester_not_on_top=false},
  DeviceState{identifier=2, name='HALF_OPENED', app_accessible=true, cancel_when_requester_not_on_top=false},
  DeviceState{identifier=3, name='OPENED', app_accessible=true, cancel_when_requester_not_on_top=false},
]
`;
/** A phone profile has one state and no hinge. */
const PHONE_STATES = `Supported states: [
  DeviceState{identifier=0, name='DEFAULT', app_accessible=true, cancel_when_requester_not_on_top=false},
]
`;

function answer(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 };
}

/** The last entry of a read sequence repeats, as a device holding its state would. */
function nextRead<T>(reads: T[]): T {
  return reads.length > 1 ? reads.shift()! : reads[0]!;
}

/**
 * One emulator, answered by command: `stateReads` are the successive `print-state` replies,
 * `keyguardReads` the successive `isKeyguardShowing` values, `posture` the console's reply.
 */
function stubEmulator(options: {
  states?: string;
  stateReads: string[];
  keyguardReads?: boolean[];
  posture?: string;
  hinge?: string;
}) {
  const stateReads = [...options.stateReads];
  const keyguardReads = [...(options.keyguardReads ?? [false])];
  mockShell.mockImplementation(async (_device, words) => {
    const command = words.join(' ');
    if (command === 'cmd device_state print-states') {
      return answer(options.states ?? PIXEL_FOLD_STATES);
    }
    if (command === 'cmd device_state print-state') return answer(`${nextRead(stateReads)}\n`);
    if (command === 'dumpsys window') {
      return answer(`    isKeyguardShowing=${nextRead(keyguardReads)}\n`);
    }
    if (command === 'wm dismiss-keyguard') return answer('');
    throw new Error(`unexpected shell command: ${command}`);
  });
  mockAdb.mockImplementation(async (_device, args) => {
    const command = args.join(' ');
    if (command.startsWith('emu posture ')) return answer(options.posture ?? 'OK\n');
    if (command === 'emu sensor get hinge-angle0') {
      return answer(options.hinge ?? 'hinge-angle0 = 0\nOK\n');
    }
    throw new Error(`unexpected adb command: ${command}`);
  });
}

function adbCommands(): string[] {
  return mockAdb.mock.calls.map(([, args]) => args.join(' '));
}

function shellCommands(): string[] {
  return mockShell.mock.calls.map(([, words]) => words.join(' '));
}

beforeEach(() => {
  mockAdb.mockReset();
  mockShell.mockReset();
  mockSleep.mockClear();
});

test('sets the console posture, waits for the device state, and dismisses the lock screen the fold raised', async () => {
  // No keyguard before the fold; the first state read still sees the open posture; the lock
  // screen shows once and is gone for three reads after the dismissal.
  stubEmulator({ stateReads: ['2', '0'], keyguardReads: [false, true, false, false, false] });

  await expect(setAndroidFoldPose(ANDROID_EMULATOR, { pose: 'closed' })).resolves.toEqual({
    pose: 'closed',
    hingeAngleDegrees: 0,
  });

  expect(adbCommands()).toEqual(['emu posture 1', 'emu sensor get hinge-angle0']);
  expect(shellCommands()).toEqual([
    'cmd device_state print-states',
    'dumpsys window',
    'cmd device_state print-state',
    'cmd device_state print-state',
    'dumpsys window',
    'wm dismiss-keyguard',
    'dumpsys window',
    'dumpsys window',
    'dumpsys window',
  ]);
});

test('waits before the first lock-screen read, so a keyguard landing after the state is still caught', async () => {
  // No keyguard before the fold or at the moment the state commits; it shows up on the next read.
  stubEmulator({ stateReads: ['0'], keyguardReads: [false, false, true, false, false, false] });

  await expect(setAndroidFoldPose(ANDROID_EMULATOR, { pose: 'closed' })).resolves.toEqual({
    pose: 'closed',
    hingeAngleDegrees: 0,
  });
  expect(shellCommands().filter((command) => command === 'wm dismiss-keyguard')).toHaveLength(1);
  // One poll precedes every keyguard read: five reads, five sleeps, none from the state settle.
  expect(mockSleep).toHaveBeenCalledTimes(5);
});

test('looks the device state up by name, so a profile numbered from 1 verifies the same pose', async () => {
  stubEmulator({
    states: GENERIC_FOLDABLE_STATES,
    stateReads: ['2'],
    hinge: 'hinge-angle0 = 90\nOK\n',
  });

  await expect(setAndroidFoldPose(ANDROID_EMULATOR, { pose: 'half-open' })).resolves.toEqual({
    pose: 'half-open',
    hingeAngleDegrees: 90,
  });
  expect(adbCommands()[0]).toBe('emu posture 2');
  expect(shellCommands()).not.toContain('wm dismiss-keyguard');
});

test('refuses a phone profile as single-panel-device before touching the console', async () => {
  stubEmulator({ states: PHONE_STATES, stateReads: ['0'] });

  await expect(setAndroidFoldPose(ANDROID_EMULATOR, { pose: 'open' })).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'single-panel-device' },
  });
  expect(mockAdb).not.toHaveBeenCalled();
});

test('refuses keyframes before touching the device', async () => {
  stubEmulator({ stateReads: ['0'] });

  await expect(
    setAndroidFoldPose(ANDROID_EMULATOR, {
      keyframes: [
        { atMs: 0, angle: 0 },
        { atMs: 1000, angle: 180 },
      ],
    }),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'fold-keyframes-unsupported' },
  });
  expect(mockAdb).not.toHaveBeenCalled();
  expect(mockShell).not.toHaveBeenCalled();
});

test('reads a KO reply as a dispatch failure even though the console exits 0', async () => {
  stubEmulator({ stateReads: ['0'], posture: 'KO: Posture 1 not supported\n' });

  await expect(setAndroidFoldPose(ANDROID_EMULATOR, { pose: 'closed' })).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'fold-posture-dispatch-failed' },
  });
});

test('fails as fold-pose-unverified when the guest never commits the device state', async () => {
  stubEmulator({ stateReads: ['2'] });

  await expect(setAndroidFoldPose(ANDROID_EMULATOR, { pose: 'closed' })).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'fold-pose-unverified', observedDeviceState: 'OPENED' },
  });
  // The settle is bounded: it ended, and every state read after the first was preceded by a poll.
  const stateReads = shellCommands().filter(
    (command) => command === 'cmd device_state print-state',
  );
  expect(stateReads.length).toBeGreaterThan(1);
  expect(mockSleep).toHaveBeenCalledTimes(stateReads.length);
});

test("fails as fold-pose-unverified when a half-open sensor angle is not the posture's 90°", async () => {
  stubEmulator({ stateReads: ['1'], hinge: 'hinge-angle0 = 120\nOK\n' });

  await expect(setAndroidFoldPose(ANDROID_EMULATOR, { pose: 'half-open' })).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: {
      reason: 'fold-pose-unverified',
      expectedHingeAngleDegrees: 90,
      hingeAngleDegrees: 120,
    },
  });
});

test('leaves a keyguard that was already showing before the fold alone', async () => {
  stubEmulator({ stateReads: ['0'], keyguardReads: [true] });

  await expect(setAndroidFoldPose(ANDROID_EMULATOR, { pose: 'closed' })).resolves.toEqual({
    pose: 'closed',
    hingeAngleDegrees: 0,
  });
  expect(shellCommands()).not.toContain('wm dismiss-keyguard');
  expect(shellCommands().filter((command) => command === 'dumpsys window')).toHaveLength(1);
});

test('fails as fold-pose-unverified when the hinge sensor disagrees with the device state', async () => {
  stubEmulator({ stateReads: ['0'], hinge: 'hinge-angle0 = 180\nOK\n' });

  await expect(setAndroidFoldPose(ANDROID_EMULATOR, { pose: 'closed' })).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'fold-pose-unverified', hingeAngleDegrees: 180 },
  });
});

test('fails when the lock screen the fold raised keeps coming back', async () => {
  stubEmulator({ stateReads: ['0'], keyguardReads: [false, true] });

  await expect(setAndroidFoldPose(ANDROID_EMULATOR, { pose: 'closed' })).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'fold-lock-screen-persists' },
  });
});
