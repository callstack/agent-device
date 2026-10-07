import type { ConnectionProviderCapabilities } from '@agent-device/contracts/remote';

export const CLOUD_WEBDRIVER_PROVIDERS = {
  browserStack: 'browserstack',
  awsDeviceFarm: 'aws-device-farm',
} as const;

export type CloudWebDriverKnownProviderName =
  (typeof CLOUD_WEBDRIVER_PROVIDERS)[keyof typeof CLOUD_WEBDRIVER_PROVIDERS];

/** The environment variables that hold BrowserStack credentials. */
export const BROWSERSTACK_CREDENTIAL_VARIABLES = {
  username: 'BROWSERSTACK_USERNAME',
  accessKey: 'BROWSERSTACK_ACCESS_KEY',
} as const;

/**
 * What a bundled provider declares before any of its code runs: the same fields an installed
 * plugin publishes under `agentDevicePlugin` in its manifest. Connect policy and the credential
 * fingerprint read this, never the provider implementation.
 */
export type CloudWebDriverProviderDeclaration = Readonly<{
  provider: CloudWebDriverKnownProviderName;
  connection: ConnectionProviderCapabilities;
  /** Absent for a provider whose credentials do not come from the environment. */
  credentialVariables?: readonly string[];
}>;

const HOSTED_WEBDRIVER_CONNECTION: ConnectionProviderCapabilities = {
  leaseKind: 'direct-device-provider',
  requiresAppAttachment: false,
  requiresRemoteDaemon: false,
  supportsArtifacts: true,
  supportsDeferredAppSelection: false,
  supportsDirectPortReverse: false,
  usesCloudWebDriverLease: true,
};

const CLOUD_WEBDRIVER_PROVIDER_DECLARATIONS: readonly CloudWebDriverProviderDeclaration[] =
  Object.freeze([
    {
      provider: CLOUD_WEBDRIVER_PROVIDERS.browserStack,
      connection: HOSTED_WEBDRIVER_CONNECTION,
      credentialVariables: Object.values(BROWSERSTACK_CREDENTIAL_VARIABLES),
    },
    {
      // AWS Device Farm reads the AWS CLI credential chain, which no environment hash identifies.
      provider: CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
      connection: { ...HOSTED_WEBDRIVER_CONNECTION, requiresAppAttachment: true },
    },
  ]);

export function cloudWebDriverProviderDeclaration(
  provider: string | undefined,
): CloudWebDriverProviderDeclaration | undefined {
  return CLOUD_WEBDRIVER_PROVIDER_DECLARATIONS.find(
    (declaration) => declaration.provider === provider,
  );
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
