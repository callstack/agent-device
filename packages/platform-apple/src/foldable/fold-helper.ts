import type { DeviceRotation, FoldKeyframe, FoldPose } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  execFailureDetails,
  isCommandTimeoutError,
  type ExecResult,
} from '@agent-device/host-kit/command';

import { IOS_HINGE_ANGLE_READ_TIMEOUT_MS } from '../core/config.ts';
import { runSimctlForDevice } from '../core/simctl.ts';
import { ensureFoldHelperBinary, type FoldHelperBinary } from './fold-helper-cache.ts';

/** The read returned no usable sample; the details say why. */
export const HINGE_ANGLE_NO_SAMPLE_REASON = 'fold-hinge-angle-no-sample';

const HINGE_ANGLE_NO_SAMPLE_HINT =
  "The fold helper's hinge read returned no valid CoreMotion sample. The details name the cause: stderr such as a simulator runtime without CMAngleManager, or timeoutMs when the read did not finish.";

const OUTPUT_VERSION = 1;

/** The orientations the guest's device-state control offers; it has no upside-down value. */
export type FoldableRotation = Exclude<DeviceRotation, 'portrait-upside-down'>;

/** The guest panel table in the `devicectl device info displays` payload shape. */
export type SimulatorPanelPayload = { result: { displays: unknown[] } };

/**
 * The fold helper bound to one simulator. Every mode is a separate `simctl spawn` of the cached
 * binary, so it reaches a simulator in any device set. `setPose` and `rotate` only dispatch HID;
 * the reads only observe, so a pose is verified by a process that never sent it.
 */
export type FoldHelper = Readonly<{
  /** Dispatches a preset pose or a keyframe trajectory through simulator HID. */
  setPose(pose: FoldPose | readonly FoldKeyframe[], signal?: AbortSignal): Promise<void>;
  /** Dispatches a device orientation through the same simulator HID control channel. */
  rotate(orientation: FoldableRotation, signal?: AbortSignal): Promise<void>;
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
      throw new AppError(
        'COMMAND_FAILED',
        failure.message,
        { ...error.details, deviceId: device.id, ...failure.details },
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
        { signal, timeoutMs: durationMs + 10_000, failure: DISPATCH_FAILURE },
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

type ModeFailure = Readonly<{ message: string; details: { reason: string; hint?: string } }>;

const DISPATCH_FAILURE: ModeFailure = {
  message: 'Unable to send the simulator hinge pose',
  details: { reason: 'fold-hid-dispatch-failed' },
};

const ROTATE_FAILURE: ModeFailure = {
  message: 'Unable to send the simulator orientation',
  details: { reason: 'orientation-hid-dispatch-failed' },
};

const NO_SAMPLE_FAILURE: ModeFailure = {
  message: 'The simulator reported no hinge angle sample',
  details: { reason: HINGE_ANGLE_NO_SAMPLE_REASON, hint: HINGE_ANGLE_NO_SAMPLE_HINT },
};

const PANELS_FAILURE: ModeFailure = {
  message: 'The simulator reported no panel table',
  details: { reason: 'fold-helper-panels-unreadable' },
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
