import { sleep } from '@agent-device/host-kit/retry';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';

import { runEmulatorConsole } from '../emulator-console.ts';

/**
 * A shake is the accelerometer swinging past a force threshold in alternating directions, which is
 * what shake detectors count. Ten swings of about 2 g along the screen's X axis clear a detector that
 * needs eight direction changes above 1.33 g within three seconds.
 */
const SHAKE_SWINGS = 10;
const SHAKE_ACCELERATION_MS2 = 20;
/** Long enough for a sensor listener at the UI rate (about 60 ms) to sample every swing. */
const SHAKE_SWING_MS = 80;

const CONSOLE_REFUSED_HINT =
  'The emulator console refused the accelerometer command. An emulator image without an acceleration sensor has nothing to shake.';
const REST_UNREADABLE_MESSAGE = 'The emulator console returned no accelerometer reading';
const CONSOLE_REFUSED_MESSAGE = 'The emulator console refused the shake';

/** The failures a shake publishes as `error.details.reason`; commands.md documents each one. */
const SHAKE_REASONS = {
  // The console gave no accelerometer reading to restore afterwards, so nothing was sent.
  restUnreadable: { reason: 'shake-rest-acceleration-unreadable' },
  // The emulator console refused an accelerometer command; `details.consoleReason` is its reply.
  consoleRefused: { reason: 'shake-console-refused' },
} as const satisfies ReasonTable<'shake'>;

type Acceleration = readonly [x: string, y: string, z: string];

/**
 * Shakes one Android emulator by overriding its accelerometer through the emulator console
 * (`sensor set acceleration`), then puts back the reading it found, so the device ends at rest in
 * the pose it started in. The restore runs even when the swings are cancelled or refused.
 */
export async function shakeAndroidEmulator(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<void> {
  const rest = await readRestAcceleration(device, signal);
  try {
    for (let swing = 0; swing < SHAKE_SWINGS; swing++) {
      signal?.throwIfAborted();
      const x = swing % 2 === 0 ? SHAKE_ACCELERATION_MS2 : -SHAKE_ACCELERATION_MS2;
      await setAcceleration(device, [String(x), rest[1], rest[2]], signal);
      await sleep(SHAKE_SWING_MS, signal);
    }
  } catch (error) {
    // The swing failure is the one to report; a restore that also fails must not replace it.
    await setAcceleration(device, rest, undefined).catch(() => undefined);
    throw error;
  }
  await setAcceleration(device, rest, undefined);
}

async function readRestAcceleration(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<Acceleration> {
  const reply = await runEmulatorConsole(device, ['sensor', 'get', 'acceleration'], signal);
  if (reply.refusal !== undefined) throw consoleRefused(device, reply, { dispatched: 'no' });
  const reading = /^acceleration\s*=\s*([^:\s]+):([^:\s]+):([^:\s]+)\s*$/m.exec(reply.stdout);
  if (!reading || reading.slice(1).some((axis) => !Number.isFinite(Number(axis)))) {
    throw new AppError('COMMAND_FAILED', REST_UNREADABLE_MESSAGE, {
      deviceId: device.id,
      reason: SHAKE_REASONS.restUnreadable.reason,
      dispatched: 'no',
      stdout: reply.stdout.trim(),
    });
  }
  return [reading[1]!, reading[2]!, reading[3]!];
}

async function setAcceleration(
  device: DeviceInfo,
  acceleration: Acceleration,
  signal: AbortSignal | undefined,
): Promise<void> {
  const reply = await runEmulatorConsole(
    device,
    ['sensor', 'set', 'acceleration', acceleration.join(':')],
    signal,
  );
  if (reply.refusal !== undefined) throw consoleRefused(device, reply);
}

function consoleRefused(
  device: DeviceInfo,
  reply: Readonly<{ stdout: string; refusal?: string }>,
  extra: Readonly<{ dispatched?: 'no' }> = {},
): AppError {
  return new AppError('COMMAND_FAILED', CONSOLE_REFUSED_MESSAGE, {
    deviceId: device.id,
    reason: SHAKE_REASONS.consoleRefused.reason,
    ...extra,
    stdout: reply.stdout.trim(),
    ...(reply.refusal ? { consoleReason: reply.refusal } : {}),
    hint: CONSOLE_REFUSED_HINT,
  });
}
