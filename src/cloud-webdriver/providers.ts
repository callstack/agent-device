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
