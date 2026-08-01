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
      // Only a driver saying "I do not implement this endpoint" justifies trying the next one.
      // A timeout, an auth rejection, a dead session or a 5xx is a real failure, and swallowing it
      // here would report it as an orientation-support problem and hide the actual cause.
      if (!isUnsupportedEndpointError(error)) throw error;
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

/**
 * W3C error codes a driver returns for an endpoint it does not implement. Keyed structurally rather
 * than by message text, so a driver rewording its prose cannot turn a real failure into a fallback.
 */
const UNSUPPORTED_ENDPOINT_W3C_ERRORS: ReadonlySet<string> = new Set([
  'unknown command',
  'unknown method',
]);

/** HTTP statuses that mean "this route does not exist here", as opposed to "it failed". */
const UNSUPPORTED_ENDPOINT_STATUSES: ReadonlySet<number> = new Set([404, 405]);

function isUnsupportedEndpointError(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  // A session that never opened, or died, is not an unsupported endpoint.
  if (error.code === 'SESSION_NOT_FOUND') return false;
  // The W3C code wins whenever the driver sent one: several real failures share the statuses
  // below, most importantly a 404 carrying `invalid session id`, which is a dead session rather
  // than a missing route. Bare status is only consulted when no code was returned at all.
  const code = readW3CErrorCode(error.details?.response);
  if (code) return UNSUPPORTED_ENDPOINT_W3C_ERRORS.has(code);
  const status = error.details?.status;
  return typeof status === 'number' && UNSUPPORTED_ENDPOINT_STATUSES.has(status);
}

function readW3CErrorCode(response: unknown): string {
  if (!response || typeof response !== 'object') return '';
  const value = (response as { value?: unknown }).value;
  if (!value || typeof value !== 'object') return '';
  const code = (value as { error?: unknown }).error;
  return typeof code === 'string' ? code : '';
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
