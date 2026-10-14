import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { execFailureDetails } from '@agent-device/host-kit/command';

import { IOS_HINGE_ANGLE_STREAM_SECONDS, IOS_HINGE_ANGLE_TIMEOUT_MS } from './config.ts';
import { runXcrun } from './tool-provider.ts';

/**
 * `devicectl device motion hinge-angle` prints one sample line per reading, formatted for humans
 * in the host locale (`Angle:180,0°` under a comma-decimal locale, `Angle: 0.0°` under a dot one).
 * The JSON output carries no samples, so the human line is the only wire form there is.
 */
const HINGE_ANGLE_SAMPLE = /Angle:\s*(-?\d+(?:[.,]\d+)?)\s*°/g;

/** The read returned no sample line; stderr in the details says why. */
export const HINGE_ANGLE_NO_SAMPLE_REASON = 'fold-hinge-angle-no-sample';

const HINGE_ANGLE_NO_SAMPLE_HINT =
  "'devicectl device motion hinge-angle' printed no sample, and foldable poses can be verified only through that stream. The stderr in the details names the cause, such as a devicectl without the subcommand or a device CoreDevice cannot reach.";

/**
 * Reads the hinge angle CoreDevice currently reports for one Apple device, in degrees: 0 is
 * closed, 180 is fully open.
 *
 * The stream in the shipping toolchain does not end when its `--session-timeout` elapses, so the
 * read is bounded by devicectl's own `--timeout`, which is the smallest value it accepts. The
 * command therefore exits non-zero by design once the deadline passes; the last sample it
 * printed before that is the answer.
 */
export async function readAppleHingeAngle(
  device: DeviceInfo,
  options: { signal?: AbortSignal } = {},
): Promise<number> {
  const args: ['devicectl', ...string[]] = [
    'devicectl',
    'device',
    'motion',
    'hinge-angle',
    '--device',
    device.id,
    '--session-timeout',
    '1',
    '--timeout',
    String(IOS_HINGE_ANGLE_STREAM_SECONDS),
  ];
  const result = await runXcrun(args, {
    allowFailure: true,
    signal: options.signal,
    timeoutMs: IOS_HINGE_ANGLE_TIMEOUT_MS,
  });
  const angle = parseHingeAngleSample(result.stdout) ?? parseHingeAngleSample(result.stderr);
  if (angle !== undefined) return angle;
  throw new AppError(
    'COMMAND_FAILED',
    'CoreDevice reported no hinge angle sample',
    execFailureDetails(result, {
      cmd: 'xcrun',
      args,
      stdout: result.stdout,
      stderr: result.stderr,
      deviceId: device.id,
      reason: HINGE_ANGLE_NO_SAMPLE_REASON,
      hint: HINGE_ANGLE_NO_SAMPLE_HINT,
    }),
  );
}

/**
 * The freshest reading the stream printed before its deadline: the last sample line, not the
 * first, so a hinge that moved during the five-second stream is reported where it is now.
 */
export function parseHingeAngleSample(output: string): number | undefined {
  let angle: number | undefined;
  for (const match of output.matchAll(HINGE_ANGLE_SAMPLE)) {
    const parsed = Number.parseFloat(match[1]!.replace(',', '.'));
    if (Number.isFinite(parsed)) angle = parsed;
  }
  return angle;
}
