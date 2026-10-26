import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { execFailureDetails, type ExecResult } from '@agent-device/host-kit/command';

import { IOS_HINGE_ANGLE_READ_TIMEOUT_MS } from '../core/config.ts';
import { runSimctlForDevice } from '../core/simctl.ts';
import { ensureFoldHelperBinary, type FoldHelperBinary } from './fold-helper-cache.ts';

/** The read returned no usable sample; the details say why. */
export const HINGE_ANGLE_NO_SAMPLE_REASON = 'fold-hinge-angle-no-sample';

const HINGE_ANGLE_NO_SAMPLE_HINT =
  "The fold helper's hinge read returned no valid CoreMotion sample. The stderr in the details names the cause, such as a simulator runtime without CMAngleManager.";

/** The panel read returned no usable table; the details say why. */
const GUEST_PANELS_UNREADABLE_REASON = 'fold-helper-panels-unreadable';

const GUEST_READBACK_VERSION = 1;

/**
 * Reads the hinge angle the simulator guest reports, in degrees: 0 is closed, 180 is fully open.
 *
 * The fold helper's `hinge` mode subscribes to CoreMotion `CMAngleManager`, the source
 * `devicectl device motion hinge-angle` relays, and never sends HID. It reports the latest sample
 * once `windowMs` has passed since the first. It runs through `simctl spawn`, so it reaches a
 * simulator in any device set.
 */
export async function readSimulatorHingeAngle(
  device: DeviceInfo,
  binary: FoldHelperBinary,
  options: { signal?: AbortSignal; windowMs?: number } = {},
): Promise<number> {
  const windowMs = options.windowMs ?? 0;
  const result = await runFoldHelperObservation(device, binary, ['hinge', String(windowMs)], {
    signal: options.signal,
    timeoutMs: IOS_HINGE_ANGLE_READ_TIMEOUT_MS + windowMs,
  });
  const angle = result.exitCode === 0 ? parseHingeReading(result.stdout) : undefined;
  if (angle !== undefined) return angle;
  throw new AppError(
    'COMMAND_FAILED',
    'The simulator reported no hinge angle sample',
    execFailureDetails(result, {
      deviceId: device.id,
      reason: HINGE_ANGLE_NO_SAMPLE_REASON,
      hint: HINGE_ANGLE_NO_SAMPLE_HINT,
    }),
  );
}

/**
 * The simulator guest's integrated panels in the `devicectl device info displays` payload shape
 * (`{ result: { displays } }`), and how many integrated panels the guest saw, readable or not.
 */
export type SimulatorPanelPayload = { result: { displays: unknown[] }; integratedCount: number };

/** Reads the guest panel table for a simulator CoreDevice cannot address. */
export async function readSimulatorPanelPayload(
  device: DeviceInfo,
  options: { signal?: AbortSignal; timeoutMs: number; helper?: FoldHelperBinary },
): Promise<SimulatorPanelPayload> {
  options.signal?.throwIfAborted();
  const binary = options.helper ?? (await ensureFoldHelperBinary({ signal: options.signal }));
  const result = await runFoldHelperObservation(device, binary, ['panels'], options);
  const payload = result.exitCode === 0 ? parsePanelsReading(result.stdout) : undefined;
  if (payload) return payload;
  throw new AppError(
    'COMMAND_FAILED',
    'The simulator reported no panel table',
    execFailureDetails(result, { deviceId: device.id, reason: GUEST_PANELS_UNREADABLE_REASON }),
  );
}

async function runFoldHelperObservation(
  device: DeviceInfo,
  binary: FoldHelperBinary,
  modeArgs: readonly ['hinge', string] | readonly ['panels'],
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<ExecResult> {
  options.signal?.throwIfAborted();
  return await runSimctlForDevice(device, ['spawn', device.id, binary.path, ...modeArgs], {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    kill: { signal: 'SIGTERM', graceMs: 1000 },
    allowFailure: true,
  });
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
  return record.version === GUEST_READBACK_VERSION ? record : undefined;
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

function parsePanelsReading(stdout: string): SimulatorPanelPayload | undefined {
  const reading = readVersionedLine(stdout);
  const displays = reading?.displays;
  const integratedCount = reading?.integratedCount;
  if (!Array.isArray(displays)) return undefined;
  if (typeof integratedCount !== 'number' || !Number.isInteger(integratedCount)) return undefined;
  if (integratedCount < displays.length) return undefined;
  return { result: { displays }, integratedCount };
}
