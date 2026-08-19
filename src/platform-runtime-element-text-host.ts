import type {
  ElementTextRuntimeHost,
  ReadTextAtPointInput,
} from '@agent-device/contracts/platform';
import { isMacOs, type DeviceInfo } from '@agent-device/kernel/device';

/**
 * The per-family "read the live text at a point" mechanics, injected into the platform packages
 * by composition (ADR 0019 §1). Each family reaches its own tool here instead of importing a
 * root module, and every branch is only ever entered for a device whose owner already reported
 * `readTextAtPoint` available — so there is no fall-through arm and no failure fallback.
 */
export function createElementTextRuntimeHost(): ElementTextRuntimeHost {
  return Object.freeze({
    readTextAtPoint: async (device: DeviceInfo, input: ReadTextAtPointInput) =>
      await readTextAtPoint(device, input),
  });
}

async function readTextAtPoint(device: DeviceInfo, input: ReadTextAtPointInput): Promise<string> {
  if (device.platform === 'android') return await readAndroidText(device, input);
  if (device.platform === 'linux') return await readLinuxText(input);
  if (usesMacOsHelperSurface(device, input)) return await readMacOsSurfaceText(input);
  // macOS app sessions run through the XCUITest runner; only desktop/menubar surfaces use the
  // helper, and every other Apple leaf reaches the runner directly.
  return await readAppleRunnerText(device, input);
}

/** Only non-app macOS surfaces are helper-read; an app session is runner-read like any Apple leaf. */
function usesMacOsHelperSurface(device: DeviceInfo, input: ReadTextAtPointInput): boolean {
  const surface = input.options?.surface;
  return isMacOs(device) && surface !== undefined && surface !== 'app';
}

async function readAndroidText(device: DeviceInfo, input: ReadTextAtPointInput): Promise<string> {
  const { readAndroidTextAtPoint } = await import('./platforms/android/input-actions.ts');
  return (await readAndroidTextAtPoint(device, input.point.x, input.point.y)) ?? '';
}

async function readLinuxText(input: ReadTextAtPointInput): Promise<string> {
  const { readLinuxTextAtPoint } = await import('./platforms/linux/snapshot.ts');
  return await readLinuxTextAtPoint(input.point.x, input.point.y, input.options?.surface);
}

async function readMacOsSurfaceText(input: ReadTextAtPointInput): Promise<string> {
  const { runMacOsReadTextAction } = await import('./platforms/apple/os/macos/helper.ts');
  const result = await runMacOsReadTextAction(input.point.x, input.point.y, {
    bundleId: input.options?.appBundleId,
    surface: input.options?.surface,
  });
  return result.text;
}

async function readAppleRunnerText(
  device: DeviceInfo,
  input: ReadTextAtPointInput,
): Promise<string> {
  const { runAppleRunnerCommand } = await import('./platforms/apple/core/runner/runner-client.ts');
  const result = await runAppleRunnerCommand(
    device,
    {
      command: 'readText',
      x: input.point.x,
      y: input.point.y,
      appBundleId: input.options?.appBundleId,
    },
    { ...input.execution },
  );
  if (typeof result.text === 'string') return result.text;
  return typeof result.message === 'string' ? result.message : '';
}
