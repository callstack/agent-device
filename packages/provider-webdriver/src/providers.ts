export const CLOUD_WEBDRIVER_PROVIDERS = {
  browserStack: 'browserstack',
  awsDeviceFarm: 'aws-device-farm',
  testMu: 'testmu',
} as const;

export type CloudWebDriverKnownProviderName =
  (typeof CLOUD_WEBDRIVER_PROVIDERS)[keyof typeof CLOUD_WEBDRIVER_PROVIDERS];

const CLOUD_WEBDRIVER_KNOWN_PROVIDERS = new Set<string>(Object.values(CLOUD_WEBDRIVER_PROVIDERS));

export function isCloudWebDriverProviderName(
  provider: string | undefined,
): provider is CloudWebDriverKnownProviderName {
  return provider !== undefined && CLOUD_WEBDRIVER_KNOWN_PROVIDERS.has(provider);
}

/**
 * The app references each hub accepts. An id outside the grammar would otherwise pass every local
 * check and fail only when the hub creates the session.
 */
export function isBrowserStackAppReference(value: string): boolean {
  return /^bs:\/\/[\w.-]+$/.test(value);
}

export function isTestMuAppReference(value: string): boolean {
  return /^lt:\/\/[\w.-]+$/.test(value);
}
