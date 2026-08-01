import {
  deviceRotationOrientation,
  deviceRotationSurfaceDegrees,
  type DeviceRotation,
} from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
import type { WebDriverClient } from './webdriver-client.ts';

export type WebDriverOrientationBackend = 'android' | 'xctest';

type OrientationTransport = 'rotation' | 'orientation';

/**
 * Sets device orientation on a hosted WebDriver session.
 *
 * The previous implementation sent `mobile: rotate`, which is not a driver command at all —
 * UiAutomator2's own error enumerates its extensions and `rotate` is absent — so orientation was a
 * hard failure on every cloud provider.
 *
 * Two transports, ordered by backend:
 *  - `POST /rotation` takes exact four-way degrees, so it is preferred wherever it works.
 *    agent-device's rotation vocabulary is four-way and this is the only endpoint that can express
 *    upside-down and left-vs-right.
 *  - `POST /orientation` is two-way. XCUITest rejects `/rotation`, so iOS leads with this and pays
 *    the cost of collapsing both landscape rotations onto one value.
 *
 * The other order is kept as a fallback each way because only BrowserStack's UiAutomator2 is
 * verified; a provider whose driver disagrees degrades instead of hard-failing.
 *
 * Note this rotates the *current* display, which the device's own rotation state can later
 * override — an activity that does not pin its orientation (a Chrome Custom Tab) may come up
 * rotated again, and needs another call once it is in the foreground.
 */
export async function setWebDriverOrientation(
  client: WebDriverClient,
  backend: WebDriverOrientationBackend,
  rotation: DeviceRotation,
): Promise<void> {
  const attempts: { transport: OrientationTransport; error: string }[] = [];

  for (const transport of backend === 'android'
    ? (['rotation', 'orientation'] as const)
    : (['orientation', 'rotation'] as const)) {
    try {
      await applyTransport(client, transport, rotation);
      return;
    } catch (error) {
      attempts.push({ transport, error: error instanceof Error ? error.message : String(error) });
    }
  }

  throw new AppError(
    'COMMAND_FAILED',
    `Could not set device orientation to ${rotation} on the hosted WebDriver session.`,
    {
      hint: 'The provider driver rejected both orientation endpoints. Set the orientation as a session capability instead, for example connect --provider-device-orientation portrait.',
      rotation,
      attempts,
    },
  );
}

async function applyTransport(
  client: WebDriverClient,
  transport: OrientationTransport,
  rotation: DeviceRotation,
): Promise<void> {
  if (transport === 'rotation') {
    await client.setRotation(deviceRotationSurfaceDegrees(rotation));
    return;
  }
  await client.setOrientation(deviceRotationOrientation(rotation));
}
