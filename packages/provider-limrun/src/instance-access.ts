import { createHash } from 'node:crypto';

/** An existing iOS instance's own API URL and token (`status.apiUrl`, `status.token`). */
export type LimrunIosInstanceAccess = Readonly<{ apiUrl: string; token: string }>;

/** An existing Android instance's own API URL, ADB WebSocket URL, and token. */
export type LimrunAndroidInstanceAccess = Readonly<{
  apiUrl: string;
  token: string;
  adbUrl: string;
}>;

/**
 * Existing instances to drive with their own credentials instead of an organization API key. A
 * platform listed here never creates or deletes instances: whoever created the instance owns it.
 */
export type LimrunInstanceAccess = Readonly<{
  ios?: LimrunIosInstanceAccess;
  android?: LimrunAndroidInstanceAccess;
}>;

/**
 * A stable local id for an attached instance, derived from the API URL that identifies it, so the
 * same instance keeps the same id across daemon restarts.
 */
export function attachedLimrunInstanceId(apiUrl: string): string {
  return `attached-${createHash('sha256').update(apiUrl).digest('hex').slice(0, 12)}`;
}
