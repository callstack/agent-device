import type { DeviceRotation, FoldKeyframe, FoldPose } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import {
  execFailureDetails,
  isCommandTimeoutError,
  type ExecResult,
} from '@agent-device/host-kit/command';

import { IOS_HINGE_ANGLE_READ_TIMEOUT_MS } from '../core/config.ts';
import { runSimctlForDevice } from '../core/simctl-execution.ts';
import { ensureFoldHelperBinary, type FoldHelperBinary } from './fold-helper-cache.ts';

export const FOLD_HELPER_REASONS = {
  // The fold helper could not send the hinge pose to the iOS simulator.
  hidDispatchFailed: { reason: 'fold-hid-dispatch-failed' },
  // The fold helper did not finish sending the hinge pose in time, so the pose may have applied.
  hidDispatchTimedOut: { reason: 'fold-hid-dispatch-timed-out' },
  // An iOS simulator hinge read returned no usable sample; `details` say why.
  hingeAngleNoSample: { reason: 'fold-hinge-angle-no-sample' },
} as const satisfies ReasonTable<'fold'>;

const FOLD_HELPER_ORIENTATION_REASONS = {
  // The fold helper could not send the orientation to the iOS simulator.
  hidDispatchFailed: { reason: 'orientation-hid-dispatch-failed' },
  // The fold helper did not finish sending the orientation in time, so the rotation may have applied.
  hidDispatchTimedOut: { reason: 'orientation-hid-dispatch-timed-out' },
} as const satisfies ReasonTable<'orientation'>;

const FOLD_HELPER_HOME_REASONS = {
  // The fold helper could not send the Home button to the iOS simulator.
  hidDispatchFailed: { reason: 'home-hid-dispatch-failed' },
  // The fold helper did not finish sending the Home button in time, so the press may have applied.
  hidDispatchTimedOut: { reason: 'home-hid-dispatch-timed-out' },
} as const satisfies ReasonTable<'home'>;

const FOLD_HELPER_PANEL_REASONS = {
  // The fold helper returned no panel table for the iOS simulator.
  panelsUnreadable: { reason: 'fold-helper-panels-unreadable' },
} as const satisfies ReasonTable<'foldable panels'>;

type FoldHelperFailureReason =
  | (typeof FOLD_HELPER_REASONS)[keyof typeof FOLD_HELPER_REASONS]['reason']
  | (typeof FOLD_HELPER_ORIENTATION_REASONS)[keyof typeof FOLD_HELPER_ORIENTATION_REASONS]['reason']
  | (typeof FOLD_HELPER_HOME_REASONS)[keyof typeof FOLD_HELPER_HOME_REASONS]['reason']
  | (typeof FOLD_HELPER_PANEL_REASONS)[keyof typeof FOLD_HELPER_PANEL_REASONS]['reason'];

const HINGE_ANGLE_NO_SAMPLE_HINT =
  "The fold helper's hinge read returned no valid CoreMotion sample. The details name the cause: stderr such as a simulator runtime without CMAngleManager, or timeoutMs when the read did not finish.";

const OUTPUT_VERSION = 1;

/** The orientations a foldable accepts as a user target; upside-down stays refused there. */
export type FoldableRotation = Exclude<DeviceRotation, 'portrait-upside-down'>;

/**
 * Every value the guest's orientation picker accepts, upside-down included: its wire spelling
 * is `pud`, which the fold helper maps from `portrait-upside-down`. The picker needs all four
 * values because the lit panel adds a fixed offset to the picker, so reaching one target
 * can require dispatching another value. Callers keep user targets to {@link FoldableRotation}.
 */
export type FoldPickerValue = DeviceRotation;

/** The guest panel table in the `devicectl device info displays` payload shape. */
export type SimulatorPanelPayload = { result: { displays: unknown[] } };

/**
 * The fold helper bound to one simulator. Every mode is a separate `simctl spawn` of the cached
 * binary, so it reaches a simulator in any device set. `setPose`, `rotate`, and `pressHome` only
 * dispatch HID; the reads only observe, so a pose is verified by a process that never sent it.
 */
export type FoldHelper = Readonly<{
  /** Dispatches a preset pose or a keyframe trajectory through simulator HID. */
  setPose(pose: FoldPose | readonly FoldKeyframe[], signal?: AbortSignal): Promise<void>;
  /** Dispatches one picker value through the same simulator HID control channel. */
  rotate(orientation: FoldPickerValue, signal?: AbortSignal): Promise<void>;
  /** Presses the Home button through simulator HID: once for home, twice for the app switcher. */
  pressHome(presses: 1 | 2, signal?: AbortSignal): Promise<void>;
  /**
   * One fresh CoreMotion `CMAngleManager` subscription, the source `devicectl device motion
   * hinge-angle` relays. It reports the latest sample once `windowMs` has passed since the first,
   * in degrees: 0 is closed, 180 is fully open.
   */
  readHingeAngle(options?: { signal?: AbortSignal; windowMs?: number }): Promise<number>;
  /** The integrated panels from the guest's CADisplay and BLSBacklight, the sources `dtdeviceinfod` relays. */
  readPanelPayload(options: {
    signal?: AbortSignal;
    timeoutMs: number;
  }): Promise<SimulatorPanelPayload>;
}>;

/**
 * Binds the fold helper to `device`. Nothing is built here: the first mode that runs builds (or
 * reuses the cached build of) the binary, and every later mode reuses that answer, so a caller that
 * refuses before any read never pays the build.
 */
export function createFoldHelper(device: DeviceInfo): FoldHelper {
  let binary: Promise<FoldHelperBinary> | undefined;
  /**
   * Runs one mode and returns what `read` takes from its stdout. A non-zero exit, an unreadable
   * output, and a timeout all become the mode's typed failure. A caller abort, a helper build
   * failure (`fold-helper-build-failed`), and any other spawn error keep their own shape.
   */
  const run = async <T>(
    args: readonly string[],
    options: { signal: AbortSignal | undefined; timeoutMs: number; failure: ModeFailure },
    read: (stdout: string) => T | undefined,
  ): Promise<T> => {
    const { signal, timeoutMs, failure } = options;
    signal?.throwIfAborted();
    const { path } = await (binary ??= ensureFoldHelperBinary({ signal }));
    signal?.throwIfAborted();
    let result: ExecResult;
    try {
      result = await runSimctlForDevice(device, ['spawn', device.id, path, ...args], {
        signal,
        timeoutMs,
        // simctl must forward termination to the guest before the host kills it.
        kill: { signal: 'SIGTERM', graceMs: 1000 },
        allowFailure: true,
      });
    } catch (error) {
      if (signal?.aborted || !isCommandTimeoutError(error)) throw error;
      const timedOut = failure.timedOut ?? failure;
      throw new AppError(
        'COMMAND_FAILED',
        timedOut.message,
        { ...error.details, deviceId: device.id, ...timedOut.details },
        error,
      );
    }
    const value = result.exitCode === 0 ? read(result.stdout) : undefined;
    if (value !== undefined) return value;
    throw new AppError(
      'COMMAND_FAILED',
      failure.message,
      execFailureDetails(result, { deviceId: device.id, ...failure.details }),
    );
  };
  return Object.freeze({
    async setPose(pose, signal) {
      const durationMs = typeof pose === 'string' ? 0 : pose.at(-1)!.atMs;
      const payload = typeof pose === 'string' ? pose : JSON.stringify(pose);
      await run(
        ['set', payload],
        {
          signal,
          timeoutMs: durationMs + 10_000,
          failure: typeof pose === 'string' ? POSE_DISPATCH_FAILURE : KEYFRAMES_DISPATCH_FAILURE,
        },
        () => true,
      );
    },
    async rotate(orientation, signal) {
      await run(
        ['rotate', orientation],
        { signal, timeoutMs: 5_000, failure: ROTATE_FAILURE },
        () => true,
      );
    },
    async pressHome(presses, signal) {
      await run(
        ['home', String(presses)],
        { signal, timeoutMs: 5_000, failure: HOME_FAILURE },
        () => true,
      );
    },
    async readHingeAngle({ signal, windowMs = 0 } = {}) {
      return await run(
        ['hinge', String(windowMs)],
        {
          signal,
          timeoutMs: IOS_HINGE_ANGLE_READ_TIMEOUT_MS + windowMs,
          failure: NO_SAMPLE_FAILURE,
        },
        parseHingeReading,
      );
    },
    async readPanelPayload({ signal, timeoutMs }) {
      return await run(['panels'], { signal, timeoutMs, failure: PANELS_FAILURE }, (stdout) => {
        const displays = readVersionedLine(stdout)?.displays;
        return Array.isArray(displays) ? { result: { displays } } : undefined;
      });
    },
  } satisfies FoldHelper);
}

type ModeFailureShape = Readonly<{
  message: string;
  details: { reason: FoldHelperFailureReason; hint?: string; dispatched?: 'unknown' };
}>;

type ModeFailure = ModeFailureShape &
  Readonly<{
    /** Replaces the failure on a timeout, for a mode whose dispatch may land after its deadline. */
    timedOut?: ModeFailureShape;
  }>;

/** The set-mode failure; `retry` says what sending the same request again does. */
function dispatchFailure(retry: string): ModeFailure {
  return {
    message: 'Unable to send the simulator hinge pose',
    details: { reason: FOLD_HELPER_REASONS.hidDispatchFailed.reason },
    timedOut: {
      message: 'Timed out sending the simulator hinge pose; the pose may have applied',
      details: {
        reason: FOLD_HELPER_REASONS.hidDispatchTimedOut.reason,
        dispatched: 'unknown',
        hint: `Check the pose with a screenshot or snapshot. ${retry}`,
      },
    },
  };
}

const POSE_DISPATCH_FAILURE = dispatchFailure(
  'A retry sends the pose again and reads the hinge back.',
);
const KEYFRAMES_DISPATCH_FAILURE = dispatchFailure(
  'A retry replays the motion from its first keyframe.',
);

const ROTATE_FAILURE: ModeFailure = {
  message: 'Unable to send the simulator orientation',
  details: { reason: FOLD_HELPER_ORIENTATION_REASONS.hidDispatchFailed.reason },
  timedOut: {
    message: 'Timed out sending the simulator orientation; the rotation may have applied',
    details: {
      reason: FOLD_HELPER_ORIENTATION_REASONS.hidDispatchTimedOut.reason,
      dispatched: 'unknown',
      hint: 'Check the orientation with a screenshot or snapshot. A retry reads the lit panel first and sends nothing when it already shows the requested orientation.',
    },
  },
};

const HOME_FAILURE: ModeFailure = {
  message: 'Unable to send the simulator Home button',
  // A failure on the second press or a key-up comes after a press already went out.
  details: { reason: FOLD_HELPER_HOME_REASONS.hidDispatchFailed.reason, dispatched: 'unknown' },
  timedOut: {
    message: 'Timed out sending the simulator Home button; the press may have applied',
    details: {
      reason: FOLD_HELPER_HOME_REASONS.hidDispatchTimedOut.reason,
      dispatched: 'unknown',
      hint: 'Check the foreground app with appstate or a screenshot before you press Home again.',
    },
  },
};

const NO_SAMPLE_FAILURE: ModeFailure = {
  message: 'The simulator reported no hinge angle sample',
  details: {
    reason: FOLD_HELPER_REASONS.hingeAngleNoSample.reason,
    hint: HINGE_ANGLE_NO_SAMPLE_HINT,
  },
};

const PANELS_FAILURE: ModeFailure = {
  message: 'The simulator reported no panel table',
  details: { reason: FOLD_HELPER_PANEL_REASONS.panelsUnreadable.reason },
};

/** The helper's one JSON line, when it is this version's shape. */
function readVersionedLine(stdout: string): Record<string, unknown> | undefined {
  const line = stdout.trim().split('\n').at(-1);
  if (!line) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  return record.version === OUTPUT_VERSION ? record : undefined;
}

/** A valid sample inside the hinge's 0–180° range; anything else is no sample. */
export function parseHingeReading(stdout: string): number | undefined {
  const reading = readVersionedLine(stdout);
  if (!reading || reading.angleValid !== true) return undefined;
  const angle = reading.angleDegrees;
  if (typeof angle !== 'number' || !Number.isFinite(angle) || angle < 0 || angle > 180) {
    return undefined;
  }
  return angle;
}
