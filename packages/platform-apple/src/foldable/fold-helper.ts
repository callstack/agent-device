import type { FoldKeyframe, FoldPose } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { execFailureDetails, type ExecResult } from '@agent-device/host-kit/command';

import { IOS_HINGE_ANGLE_READ_TIMEOUT_MS } from '../core/config.ts';
import { runSimctlForDevice } from '../core/simctl.ts';
import { ensureFoldHelperBinary } from './fold-helper-cache.ts';

/** The read returned no usable sample; the details say why. */
export const HINGE_ANGLE_NO_SAMPLE_REASON = 'fold-hinge-angle-no-sample';

const HINGE_ANGLE_NO_SAMPLE_HINT =
  "The fold helper's hinge read returned no valid CoreMotion sample. The stderr in the details names the cause, such as a simulator runtime without CMAngleManager.";

const OUTPUT_VERSION = 1;

/** The guest panel table in the `devicectl device info displays` payload shape. */
export type SimulatorPanelPayload = { result: { displays: unknown[] } };

/**
 * The fold helper bound to one simulator. Every mode is a separate `simctl spawn` of the cached
 * binary, so it reaches a simulator in any device set. `setPose` only dispatches HID; the reads
 * only observe, so a pose is verified by a process that never sent it.
 */
export type FoldHelper = Readonly<{
  /** Dispatches a preset pose or a keyframe trajectory through simulator HID. */
  setPose(pose: FoldPose | readonly FoldKeyframe[], signal?: AbortSignal): Promise<void>;
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

/** Builds (or reuses the cached build of) the fold helper and binds it to `device`. */
export async function openFoldHelper(
  device: DeviceInfo,
  options: { signal?: AbortSignal } = {},
): Promise<FoldHelper> {
  options.signal?.throwIfAborted();
  const binary = await ensureFoldHelperBinary({ signal: options.signal });
  const run = (args: readonly string[], signal: AbortSignal | undefined, timeoutMs: number) => {
    signal?.throwIfAborted();
    return runSimctlForDevice(device, ['spawn', device.id, binary.path, ...args], {
      signal,
      timeoutMs,
      // simctl must forward termination to the guest before the host kills it.
      kill: { signal: 'SIGTERM', graceMs: 1000 },
      allowFailure: true,
    });
  };
  return Object.freeze({
    async setPose(pose, signal) {
      const durationMs = typeof pose === 'string' ? 0 : pose.at(-1)!.atMs;
      const payload = typeof pose === 'string' ? pose : JSON.stringify(pose);
      const sent = await run(['set', payload], signal, durationMs + 10_000);
      if (sent.exitCode === 0) return;
      throw helperFailure(device, sent, 'Unable to send the simulator hinge pose', {
        reason: 'fold-hid-dispatch-failed',
      });
    },
    async readHingeAngle({ signal, windowMs = 0 } = {}) {
      const result = await run(
        ['hinge', String(windowMs)],
        signal,
        IOS_HINGE_ANGLE_READ_TIMEOUT_MS + windowMs,
      );
      const angle = result.exitCode === 0 ? parseHingeReading(result.stdout) : undefined;
      if (angle !== undefined) return angle;
      throw helperFailure(device, result, 'The simulator reported no hinge angle sample', {
        reason: HINGE_ANGLE_NO_SAMPLE_REASON,
        hint: HINGE_ANGLE_NO_SAMPLE_HINT,
      });
    },
    async readPanelPayload({ signal, timeoutMs }) {
      const result = await run(['panels'], signal, timeoutMs);
      const displays =
        result.exitCode === 0 ? readVersionedLine(result.stdout)?.displays : undefined;
      if (Array.isArray(displays)) return { result: { displays } };
      throw helperFailure(device, result, 'The simulator reported no panel table', {
        reason: 'fold-helper-panels-unreadable',
      });
    },
  } satisfies FoldHelper);
}

function helperFailure(
  device: DeviceInfo,
  result: ExecResult,
  message: string,
  details: { reason: string; hint?: string },
): AppError {
  return new AppError(
    'COMMAND_FAILED',
    message,
    execFailureDetails(result, { deviceId: device.id, ...details }),
  );
}

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
