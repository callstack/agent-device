export const ALERT_POLL_INTERVAL_MS = 300;
export const DEFAULT_ALERT_TIMEOUT_MS = 10_000;
export const ALERT_ACTION_RETRY_MS = 2_000;

/**
 * The one alert failure the family retries on: the backend looked and there was no alert *yet*.
 * Both Apple backends state it in typed form — the XCTest runner as this `ErrorPayload.code`
 * (surfacing as `details.runnerErrorCode`, like `RUNNER_BUSY`, without changing the wire error
 * code), the macOS helper as `details.reason`. Retry and the fallback hint key on these, never on
 * the message text: a transport, runner or helper failure must never read as an absent alert.
 */
export const ALERT_NOT_FOUND_RUNNER_CODE = 'ALERT_NOT_FOUND';
export const ALERT_NOT_FOUND_REASON = 'alert-not-found';

export const ALERT_ACTIONS = ['get', 'accept', 'dismiss', 'wait'] as const;
export type AlertAction = (typeof ALERT_ACTIONS)[number];

export type AlertPlatform = 'android' | 'ios' | 'macos';

export type AlertSource = 'permission' | 'native-dialog' | 'system-dialog';

export type AlertInfo = {
  title?: string;
  message?: string;
  buttons?: string[];
  platform?: AlertPlatform;
  source?: AlertSource;
  packageName?: string;
};
