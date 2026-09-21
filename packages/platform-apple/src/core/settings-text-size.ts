import {
  parseTextSizeCategory,
  readTextSizeCategory,
  textSizeSettingPayload,
  type TextSizeSettingPayload,
} from '@agent-device/contracts/settings';
import { resolveDeviceAppleOs, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { requireExecSuccess } from '@agent-device/host-kit/command';
import { runSimctl } from './apps-simctl.ts';
import { ensureBootedSimulator } from './simulator.ts';

/**
 * The Apple half of `settings text-size`: `simctl ui <device> content_size` is both the reader and
 * the writer, and it names the ladder verbatim, so no translation table sits between the shared
 * vocabulary and the tool.
 *
 * Both halves are confined to the iPhone/iPad simulator leaf. The `settings` admission is one cell
 * for the whole command and covers every Apple simulator, so this is the per-setting refusal: the
 * content-size surface was only ever verified on that leaf, and a write that reached an Apple TV or
 * Vision Pro simulator would be reported as applied on a device whose setting may not exist.
 */

const TEXT_SIZE_LEAF_UNAVAILABLE =
  'Reading or setting a text size is supported on iOS and iPadOS simulators.' as const;

function requireTextSizeLeaf(device: DeviceInfo): void {
  const appleOs = resolveDeviceAppleOs(device);
  if (device.kind === 'simulator' && (appleOs === 'ios' || appleOs === 'ipados')) return;
  throw new AppError('UNSUPPORTED_OPERATION', TEXT_SIZE_LEAF_UNAVAILABLE, {
    deviceId: device.id,
    appleOs,
    deviceKind: device.kind,
    reason: 'setting-unsupported-on-leaf',
    hint: 'Run `xcrun simctl ui <device> content_size` on a booted iPhone or iPad simulator.',
  });
}

/**
 * Applies one ladder rung. The category arrives validated because `simctl` answers an unknown
 * category with exit 0 and the single word `Invalid argument` — a write that delegated validation
 * to the tool would report success while changing nothing. `setIosSetting` has already required a
 * booted simulator for every setting it serves.
 */
export async function setIosTextSize(
  device: DeviceInfo,
  state: string,
): Promise<TextSizeSettingPayload> {
  requireTextSizeLeaf(device);
  const category = parseTextSizeCategory(state);
  await runSimctl(device, ['ui', device.id, 'content_size', category]);
  return textSizeSettingPayload(category, category);
}

/**
 * Reads the rung the simulator holds. A simulator that never had a size set answers with its
 * default, and one that is not booted answers `unknown`; only a value the ladder names is a
 * successful read, so anything else fails with the tool's own output rather than being normalized
 * into a category the simulator never reported.
 */
export async function readIosTextSize(device: DeviceInfo): Promise<TextSizeSettingPayload> {
  requireTextSizeLeaf(device);
  await ensureBootedSimulator(device);
  const result = requireExecSuccess(
    await runSimctl(device, ['ui', device.id, 'content_size'], { allowFailure: true }),
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
