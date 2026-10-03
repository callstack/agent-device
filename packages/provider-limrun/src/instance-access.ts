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
 * Who owns an instance: `created` instances were created by this runtime, which deletes them;
 * `attached` instances belong to someone else and are never deleted.
 */
export type LimrunInstanceOwnership = 'created' | 'attached';
