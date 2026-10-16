import {
  parseTextSizeCategory,
  readTextSizeCategory,
  textSizeSettingPayload,
  type TextSizeSettingPayload,
} from '@agent-device/contracts/settings';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { requireExecSuccess } from '@agent-device/host-kit/command';
import { runSimctlForDevice } from './simctl.ts';
import { ensureBootedSimulator } from './simulator.ts';

/** `simctl ui <device> content_size` reads and writes the ladder's names verbatim. */

/** `simctl` answers an unknown category with exit 0, so the category is parsed first. */
export async function setIosTextSize(
  device: DeviceInfo,
  state: string,
): Promise<TextSizeSettingPayload> {
  const category = parseTextSizeCategory(state);
  await runSimctlForDevice(device, ['ui', device.id, 'content_size', category]);
  return textSizeSettingPayload(category, category);
}

/**
 * Reads the rung the simulator holds. A simulator that never had a size set answers with its
 * default, and one that is not booted answers `unknown`; only a value the ladder names is a
 * successful read, so anything else fails with the tool's own output rather than being normalized
 * into a category the simulator never reported.
 */
export async function readIosTextSize(device: DeviceInfo): Promise<TextSizeSettingPayload> {
  await ensureBootedSimulator(device);
  const result = requireExecSuccess(
    await runSimctlForDevice(device, ['ui', device.id, 'content_size'], { allowFailure: true }),
    'Failed to read iOS content size category',
  );
  const reported = result.stdout.trim();
  const category = readTextSizeCategory(reported);
  if (category === undefined) {
    throw new AppError(
      'COMMAND_FAILED',
      `iOS simulator reported an unknown text size: ${reported || '(empty)'}`,
      {
        deviceId: device.id,
        stdout: result.stdout,
        stderr: result.stderr,
        hint: 'Boot the simulator, or run `xcrun simctl ui <device> content_size` to see what it reports.',
      },
    );
  }
  // The payload carries what the tool answered with, capitalization and all: simctl echoes some
  // rungs back as `extra-Small`, and a read is only auditable if the value the device said survives
  // beside the category the ladder calls it.
  return textSizeSettingPayload(category, reported);
}
