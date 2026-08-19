import {
  elementTextRead,
  type ElementTextReadOutcome,
  type ElementTextRuntimeHost,
  type ReadTextAtPointInput,
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

async function readTextAtPoint(
  device: DeviceInfo,
  input: ReadTextAtPointInput,
): Promise<ElementTextReadOutcome> {
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

// Each reader classifies its own owner's "nothing here" answer through `elementTextRead`.
// None of them catches: a transport or tooling failure is unexpected and propagates.

async function readAndroidText(
  device: DeviceInfo,
  input: ReadTextAtPointInput,
): Promise<ElementTextReadOutcome> {
  const { readAndroidTextAtPoint } = await import('./platforms/android/input-actions.ts');
  // uiautomator answers `undefined` when no node covers the point.
  return elementTextRead(await readAndroidTextAtPoint(device, input.point.x, input.point.y));
}

async function readLinuxText(input: ReadTextAtPointInput): Promise<ElementTextReadOutcome> {
  const { readLinuxTextAtPoint } = await import('./platforms/linux/snapshot.ts');
  return elementTextRead(
    await readLinuxTextAtPoint(input.point.x, input.point.y, input.options?.surface),
  );
}

async function readMacOsSurfaceText(input: ReadTextAtPointInput): Promise<ElementTextReadOutcome> {
  const { runMacOsReadTextAction } = await import('./platforms/apple/os/macos/helper.ts');
  const result = await runMacOsReadTextAction(input.point.x, input.point.y, {
    bundleId: input.options?.appBundleId,
    surface: input.options?.surface,
  });
  return elementTextRead(result.text);
}

async function readAppleRunnerText(
  device: DeviceInfo,
  input: ReadTextAtPointInput,
): Promise<ElementTextReadOutcome> {
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
  if (typeof result.text === 'string') return elementTextRead(result.text);
  // The runner answers `message` instead of `text` when it queried the element but could not
  // render readable text from it — a declined read, not a failed one.
  return typeof result.message === 'string'
    ? elementTextRead(result.message)
    : Object.freeze({ status: 'unreadable', reason: 'surface-not-readable' } as const);
}
