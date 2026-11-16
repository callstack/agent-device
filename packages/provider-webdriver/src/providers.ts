import type { ConnectionProviderCapabilities } from '@agent-device/contracts/remote';

export const CLOUD_WEBDRIVER_PROVIDERS = {
  awsDeviceFarm: 'aws-device-farm',
} as const;

export type CloudWebDriverKnownProviderName =
  (typeof CLOUD_WEBDRIVER_PROVIDERS)[keyof typeof CLOUD_WEBDRIVER_PROVIDERS];

/**
 * What a bundled provider declares before any of its code runs: the same fields an installed
 * plugin returns from its factory. Connect policy and the credential fingerprint read this, never
 * the provider implementation.
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

export const CLOUD_WEBDRIVER_PROVIDER_DECLARATIONS: readonly CloudWebDriverProviderDeclaration[] =
  Object.freeze([
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

/**
 * URI schemes are case-insensitive, but hosted hubs only match the lower-case spelling, so
 * `BS://id` is returned as `bs://id`. Anything without the lower-case `scheme` returns undefined.
 */
export function canonicalSchemeReference(app: string, scheme: string): string | undefined {
  if (app.slice(0, scheme.length).toLowerCase() !== scheme) return undefined;
  return `${scheme}${app.slice(scheme.length)}`;
}
