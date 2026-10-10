import type { FoldPose, SetFoldPoseInput } from '@agent-device/contracts/device';
import type { SetFoldPoseResult } from '@agent-device/contracts/fold-runtime';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { sleep } from '@agent-device/host-kit/retry';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

import { runAndroidAdb, runAndroidShell } from '../adb.ts';
import { androidAdbResultError } from '../adb-failure.ts';
import type { AndroidAdbExecutorResult } from '../adb-transport.ts';

/**
 * The emulator console's posture ids (`adb emu posture <id>`) and the device state Android
 * derives from each. The console moves the hinge sensor to the angle the AVD profile defines for
 * the posture (0°, 90°, 180° on the Pixel folds; 15°, 90°, 165° on the generic "7.6in Foldable",
 * the midpoints of its posture ranges), and `DeviceStateManager` commits the matching state once
 * the guest has seen it. The state *ids* differ per profile too (the Pixel folds number `CLOSED`
 * 0, the generic foldables 1), so they are looked up by name, and the committed state, which is
 * what `WindowManager`'s `FoldingFeature` derives from, is the verification; the angle is reported
 * as the sensor reads it.
 */
const EMULATOR_POSTURES = Object.freeze({
  closed: { id: '1', state: 'CLOSED' },
  'half-open': { id: '2', state: 'HALF_OPENED' },
  open: { id: '3', state: 'OPENED' },
} as const);
/** Reads until the guest commits the posture's device state; `attempts × poll` is the settle budget. */
const ANDROID_FOLD_SETTLE_ATTEMPTS = 60;
const ANDROID_FOLD_SETTLE_POLL_MS = 250;
/**
 * The lock screen can land after the device state did, so every read waits a poll first and the
 * keyguard must stay away for this many consecutive reads (about 750 ms of quiet) before the fold
 * is done.
 */
const LOCK_SCREEN_CLEAR_READS = 3;

const FOLDABLE_REQUIRED_HINT =
  'fold poses the hinge of a foldable emulator such as the Pixel 9 Pro Fold; this emulator lists no CLOSED, HALF_OPENED, or OPENED device state, so it has no hinge to pose.';
const KEYFRAMES_HINT =
  'The emulator console poses the hinge at fixed angles only; request closed, half-open, or open.';
const POSTURE_DISPATCH_HINT =
  'The emulator console refused the posture. Check that the AVD is a foldable profile (hw.sensor.hinge=yes), then retry.';
const POSE_UNVERIFIED_HINT =
  'The emulator console accepted the posture, but the guest did not commit the matching device state. Read it directly with `adb shell cmd device_state print-state` to see which state the emulator holds.';
const HINGE_ANGLE_HINT =
  'The emulator console answered the posture but exposes no hinge-angle0 sensor to read back; check that the AVD is a foldable profile (hw.sensor.hinge=yes) and that the emulator build supports `sensor get hinge-angle0`.';
const LOCK_SCREEN_HINT =
  'The fold lit a panel Android keeps locked and `wm dismiss-keyguard` did not clear it; a keyguard with a PIN or password has to be unlocked by hand.';

/** Poses a foldable emulator's hinge through the emulator console and verifies the device state the guest commits. */
export async function setAndroidFoldPose(
  device: DeviceInfo,
  input: SetFoldPoseInput,
  options: { signal?: AbortSignal } = {},
): Promise<SetFoldPoseResult> {
  const { signal } = options;
  signal?.throwIfAborted();
  const pose = requirePosePreset(device, input);
  const states = await readDeviceStates(device, signal);
  const posture = EMULATOR_POSTURES[pose];
  const expectedState = requirePostureState(device, pose, states);

  // Only a fold to the cover display raises the keyguard, and a keyguard already showing is not
  // the fold's to clear: only one that `closed` raises is dismissed.
  const lockedBefore = pose === 'closed' && (await isKeyguardShowing(device, signal));
  await sendEmulatorPosture(device, pose, posture.id, signal);
  emitDiagnostic({
    level: 'info',
    phase: 'android_fold_pose_dispatched',
    data: { deviceId: device.id, pose },
  });

  await awaitDeviceState(device, pose, expectedState, states, signal);
  if (pose === 'closed' && !lockedBefore) await dismissFoldLockScreen(device, signal);
  return { pose, hingeAngleDegrees: await readHingeAngle(device, signal) };
}

/**
 * The id of the requested posture's device state. A profile that lists none of the posture states
 * has no hinge at all; one that lists some but not the requested one has a hinge the console
 * cannot pose this way, which is its own refusal rather than a single-panel one.
 */
function requirePostureState(
  device: DeviceInfo,
  pose: FoldPose,
  states: ReadonlyMap<string, string>,
): string {
  const posture = EMULATOR_POSTURES[pose];
  const expectedState = states.get(posture.state);
  if (expectedState !== undefined) return expectedState;
  const listed = Object.values(EMULATOR_POSTURES)
    .map((candidate) => candidate.state)
    .filter((state) => states.has(state));
  if (listed.length === 0) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `${device.name} is not a foldable emulator: it lists no CLOSED, HALF_OPENED, or OPENED device state`,
      { deviceId: device.id, reason: 'single-panel-device', hint: FOLDABLE_REQUIRED_HINT },
    );
  }
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    `${device.name} has no ${posture.state} device state to commit for the ${pose} pose; it lists ${listed.join(', ')}`,
    {
      deviceId: device.id,
      reason: 'fold-posture-unsupported',
      requestedPose: pose,
      deviceStates: listed,
      hint: `This profile poses only ${listed.join(' and ')}; request one of those poses.`,
    },
  );
}

/** The console poses fixed postures only, so a keyframe trajectory has no Android driver. */
function requirePosePreset(device: DeviceInfo, input: SetFoldPoseInput): FoldPose {
  if (input.pose === undefined) {
    throw new AppError('UNSUPPORTED_OPERATION', 'fold keyframes are not supported on Android', {
      deviceId: device.id,
      reason: 'fold-keyframes-unsupported',
      hint: KEYFRAMES_HINT,
    });
  }
  return input.pose;
}

/** The device states the guest can commit, by name, as `cmd device_state print-states` lists them. */
async function readDeviceStates(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<Map<string, string>> {
  const { stdout } = await shell(device, ['cmd', 'device_state', 'print-states'], signal);
  const states = new Map<string, string>();
  for (const match of stdout.matchAll(/identifier=(\d+), name='([A-Z_]+)'/g)) {
    states.set(match[2]!, match[1]!);
  }
  return states;
}

/** The console answers `OK` or `KO: …` on stdout and exits 0 either way, so the reply is the verdict. */
async function sendEmulatorPosture(
  device: DeviceInfo,
  pose: FoldPose,
  postureId: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const sent = await emulatorConsole(device, ['emu', 'posture', postureId], signal);
  if (/^KO\b/m.test(sent.stdout)) {
    throw new AppError('COMMAND_FAILED', `Unable to set the emulator posture for ${pose}`, {
      deviceId: device.id,
      reason: 'fold-posture-dispatch-failed',
      stdout: sent.stdout.trim(),
      hint: POSTURE_DISPATCH_HINT,
    });
  }
}

/**
 * The console returns before the guest reacts, and a posture the console accepted is not yet a
 * pose the app sees, so the device state is the verification: it is what `WindowManager`'s
 * `FoldingFeature` is derived from.
 */
async function awaitDeviceState(
  device: DeviceInfo,
  pose: FoldPose,
  expectedState: string,
  states: ReadonlyMap<string, string>,
  signal: AbortSignal | undefined,
): Promise<void> {
  let observed: string | undefined;
  for (let attempt = 1; attempt <= ANDROID_FOLD_SETTLE_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    observed = await readDeviceState(device, signal);
    if (observed === expectedState) return;
    await sleep(ANDROID_FOLD_SETTLE_POLL_MS, signal);
  }
  const observedName = [...states].find(([, id]) => id === observed)?.[0];
  throw new AppError(
    'COMMAND_FAILED',
    `${device.name} did not reach the ${pose} pose: the emulator still reports device state ${observedName ?? observed}`,
    {
      deviceId: device.id,
      requestedPose: pose,
      observedDeviceState: observedName ?? observed,
      reason: 'fold-pose-unverified',
      hint: POSE_UNVERIFIED_HINT,
    },
  );
}

async function readDeviceState(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const { stdout } = await shell(device, ['cmd', 'device_state', 'print-state'], signal);
  return /\d+/.exec(stdout)?.[0];
}

/**
 * Folding to the cover display raises the keyguard on Pixel images ("Swipe up to continue"):
 * Android's continue-using-apps-on-fold setting, which the emulator images do not honour. Left
 * alone, every later capture reads the lock screen instead of the app, so it is dismissed the
 * way the swipe would. The keyguard can land after the device state did, so it has to stay away
 * for consecutive reads before the fold is done. Runs only for `closed` (unfolding lights the
 * inner display, which raises nothing) and only when the keyguard was not showing before the
 * fold.
 */
async function dismissFoldLockScreen(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<void> {
  let clearReads = 0;
  let dismissed = false;
  for (let attempt = 1; attempt <= ANDROID_FOLD_SETTLE_ATTEMPTS; attempt += 1) {
    await sleep(ANDROID_FOLD_SETTLE_POLL_MS, signal);
    if (await isKeyguardShowing(device, signal)) {
      clearReads = 0;
      dismissed = true;
      await shell(device, ['wm', 'dismiss-keyguard'], signal);
    } else {
      clearReads += 1;
      if (clearReads >= LOCK_SCREEN_CLEAR_READS) break;
    }
  }
  if (clearReads < LOCK_SCREEN_CLEAR_READS) {
    throw new AppError('COMMAND_FAILED', `${device.name} stays locked after the fold`, {
      deviceId: device.id,
      reason: 'fold-lock-screen-persists',
      hint: LOCK_SCREEN_HINT,
    });
  }
  if (dismissed) {
    emitDiagnostic({
      level: 'info',
      phase: 'android_fold_lock_screen_dismissed',
      data: { deviceId: device.id },
    });
  }
}

async function isKeyguardShowing(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const { stdout } = await shell(device, ['dumpsys', 'window'], signal);
  return stdout.includes('isKeyguardShowing=true');
}

/** The hinge sensor the guest reads, as the console reports it: `hinge-angle0 = <degrees>`. */
async function readHingeAngle(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<number> {
  const { stdout } = await emulatorConsole(
    device,
    ['emu', 'sensor', 'get', 'hinge-angle0'],
    signal,
  );
  const match = /hinge-angle0\s*=\s*(-?\d+(?:\.\d+)?)/.exec(stdout);
  if (!match) {
    throw new AppError('COMMAND_FAILED', `${device.name} reports no hinge angle`, {
      deviceId: device.id,
      reason: 'fold-hinge-angle-unreadable',
      stdout: stdout.trim(),
      hint: HINGE_ANGLE_HINT,
    });
  }
  return Number(match[1]);
}

/**
 * An executor may hand back a failed result instead of throwing (the managed scoped transport
 * does), so every read checks the exit code itself before trusting stdout: a failed
 * `print-states` must be an adb failure, never an empty state list read as a phone.
 */
async function shell(
  device: DeviceInfo,
  words: readonly string[],
  signal: AbortSignal | undefined,
): Promise<AndroidAdbExecutorResult> {
  const result = await runAndroidShell(device, words, { signal, allowFailure: true });
  if (result.exitCode !== 0) {
    throw androidAdbResultError(
      `adb shell ${words.join(' ')} exited with code ${result.exitCode}`,
      result,
      { deviceId: device.id },
    );
  }
  return result;
}

/** The emulator console through adb, with the same exit-code check as {@link shell}. */
async function emulatorConsole(
  device: DeviceInfo,
  args: readonly string[],
  signal: AbortSignal | undefined,
): Promise<AndroidAdbExecutorResult> {
  const result = await runAndroidAdb(device, args, { signal, allowFailure: true });
  if (result.exitCode !== 0) {
    throw androidAdbResultError(
      `adb ${args.join(' ')} exited with code ${result.exitCode}`,
      result,
      {
        deviceId: device.id,
      },
    );
  }
  return result;
}
