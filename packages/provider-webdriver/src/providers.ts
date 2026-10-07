export const CLOUD_WEBDRIVER_PROVIDERS = {
  browserStack: 'browserstack',
  awsDeviceFarm: 'aws-device-farm',
} as const;

export type CloudWebDriverKnownProviderName =
  (typeof CLOUD_WEBDRIVER_PROVIDERS)[keyof typeof CLOUD_WEBDRIVER_PROVIDERS];

const CLOUD_WEBDRIVER_KNOWN_PROVIDERS = new Set<string>(Object.values(CLOUD_WEBDRIVER_PROVIDERS));

export function isCloudWebDriverProviderName(
  provider: string | undefined,
): provider is CloudWebDriverKnownProviderName {
  return provider !== undefined && CLOUD_WEBDRIVER_KNOWN_PROVIDERS.has(provider);
}

/** The environment variables that hold BrowserStack credentials. */
export const BROWSERSTACK_CREDENTIAL_VARIABLES = {
  username: 'BROWSERSTACK_USERNAME',
  accessKey: 'BROWSERSTACK_ACCESS_KEY',
} as const;

/** The BrowserStack credentials in the environment, exactly as every consumer and the fingerprint use them. */
export function readBrowserStackCredentials(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<{ username?: string; accessKey?: string }> {
  return {
    username: env[BROWSERSTACK_CREDENTIAL_VARIABLES.username] || undefined,
    accessKey: env[BROWSERSTACK_CREDENTIAL_VARIABLES.accessKey] || undefined,
  };
}

const BROWSERSTACK_APP_SCHEME = 'bs://';

/**
 * URI schemes are case-insensitive, but hosted hubs only match the lower-case spelling, so
 * `BS://id` is returned as `bs://id`. Anything without the lower-case `scheme` returns undefined.
 */
export function canonicalSchemeReference(app: string, scheme: string): string | undefined {
  if (app.slice(0, scheme.length).toLowerCase() !== scheme) return undefined;
  return `${scheme}${app.slice(scheme.length)}`;
}

export function canonicalBrowserStackAppReference(app: string): string | undefined {
  return canonicalSchemeReference(app, BROWSERSTACK_APP_SCHEME);
}

/** An id outside this grammar would pass every local check and fail only at session creation. */
export function isBrowserStackAppReference(reference: string): boolean {
  return /^bs:\/\/[\w.-]+$/.test(reference);
}
