import type {
  LaunchedProcessCheck,
  LaunchedProcessStopConfirmation,
} from '@agent-device/contracts/device-boot';
import type { AndroidEmulatorLaunchIdentity } from '@agent-device/contracts/device-readiness-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { vi } from 'vitest';

/**
 * How the root-composed launched-process owner answers, so a session suite can name what the host said
 * about the process its session launched without touching the real process table. Cases set the
 * fields they care about and assert the session's branching on the answer; the process reads behind
 * each answer, and what the composed owner really does per device kind, are pinned in the Android and
 * composition lanes.
 */
export type LaunchedProcessOwnerAnswers = {
  /** What the owner answers for its device kind when the recorded launch is still itself. */
  check: LaunchedProcessCheck;
  /** What the owner answers once a stop was asked for. */
  confirmation: LaunchedProcessStopConfirmation;
  /** What the owner answers when the launch itself is asked to stop. */
  stop: LaunchedProcessStopConfirmation;
  /** When set, the launch stop answers this instead, standing for a host that refuses the stop. */
  stopError: Error | undefined;
  /** Every check that was asked, in order, with what it was asked about. */
  checks: Array<{ device: DeviceInfo; identity: AndroidEmulatorLaunchIdentity | undefined }>;
  /** Every stop confirmation that was asked, in order. */
  confirmations: AndroidEmulatorLaunchIdentity[];
  /** Every launch stop that was asked, in order. */
  stops: AndroidEmulatorLaunchIdentity[];
};

/** The one model the seams below answer from, shared by the fixture and the cases. */
export const launchedProcessOwnerAnswers: LaunchedProcessOwnerAnswers = {
  check: 'same',
  confirmation: 'stopped',
  stop: 'stopped',
  stopError: undefined,
  checks: [],
  confirmations: [],
  stops: [],
};

/**
 * Returns the owner to a live, unchanged launched process that takes its stop, before each case.
 */
export function resetLaunchedProcessOwnerAnswers(): void {
  launchedProcessOwnerAnswers.check = 'same';
  launchedProcessOwnerAnswers.confirmation = 'stopped';
  launchedProcessOwnerAnswers.stop = 'stopped';
  launchedProcessOwnerAnswers.stopError = undefined;
  launchedProcessOwnerAnswers.checks.length = 0;
  launchedProcessOwnerAnswers.confirmations.length = 0;
  launchedProcessOwnerAnswers.stops.length = 0;
}

/**
 * The launched-process answers over the model above, as stable module-level members.
 */
export const checkLaunchedProcessFixture = vi.fn(
  async (
    device: DeviceInfo,
    identity: AndroidEmulatorLaunchIdentity | undefined,
  ): Promise<LaunchedProcessCheck> => {
    launchedProcessOwnerAnswers.checks.push({ device, identity });
    return answerForDeviceCheck(device, identity);
  },
);

export const confirmLaunchedProcessStoppedFixture = vi.fn(
  async (
    _device: DeviceInfo,
    identity: AndroidEmulatorLaunchIdentity,
  ): Promise<LaunchedProcessStopConfirmation> => {
    launchedProcessOwnerAnswers.confirmations.push(identity);
    return launchedProcessOwnerAnswers.confirmation;
  },
);

export const stopLaunchedDeviceProcessFixture = vi.fn(
  async (
    _device: DeviceInfo,
    identity: AndroidEmulatorLaunchIdentity,
  ): Promise<LaunchedProcessStopConfirmation> => {
    launchedProcessOwnerAnswers.stops.push(identity);
    if (launchedProcessOwnerAnswers.stopError) throw launchedProcessOwnerAnswers.stopError;
    return launchedProcessOwnerAnswers.stop;
  },
);

/**
 * The one stated rule: an Android emulator is the device whose boot this host starts as a process it
 * can later name, and a launch that recorded no identity has nothing to verify. Every other device
 * answers `not-applicable`, so the caller stops it on the platform's answer alone.
 */
function answerForDeviceCheck(
  device: DeviceInfo,
  identity: AndroidEmulatorLaunchIdentity | undefined,
): LaunchedProcessCheck {
  if (device.platform !== 'android' || device.kind !== 'emulator') return 'not-applicable';
  return identity ? launchedProcessOwnerAnswers.check : 'unverified';
}
