import { requireEnv } from '@agent-device/provider-webdriver/plugin';
import { canonicalSchemeReference } from '@agent-device/provider-webdriver/providers';

/** The provider id the registry, connection profiles, and `connect browserstack` use. */
export const PROVIDER = 'browserstack';

/** The environment variables that hold BrowserStack credentials. */
export const BROWSERSTACK_CREDENTIAL_VARIABLES = {
  username: 'BROWSERSTACK_USERNAME',
  accessKey: 'BROWSERSTACK_ACCESS_KEY',
} as const;

export function requireBrowserStackCredentials(
  env: Readonly<Record<string, string | undefined>>,
  providerLabel: string,
): { username: string; accessKey: string } {
  return {
    username: requireEnv(env, BROWSERSTACK_CREDENTIAL_VARIABLES.username, providerLabel),
    accessKey: requireEnv(env, BROWSERSTACK_CREDENTIAL_VARIABLES.accessKey, providerLabel),
  };
}

export function isBrowserStackAppReference(reference: string): boolean {
  return /^bs:\/\/[\w.-]+$/.test(reference);
}

export function canonicalBrowserStackAppReference(app: string): string | undefined {
  return canonicalSchemeReference(app, 'bs://');
}
