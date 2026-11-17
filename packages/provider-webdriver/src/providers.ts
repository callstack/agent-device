import type { ConnectionProviderCapabilities } from '@agent-device/contracts/remote';

export const HOSTED_WEBDRIVER_CONNECTION: ConnectionProviderCapabilities = {
  leaseKind: 'direct-device-provider',
  requiresAppAttachment: false,
  requiresRemoteDaemon: false,
  supportsArtifacts: true,
  supportsDeferredAppSelection: false,
  supportsDirectPortReverse: false,
  usesCloudWebDriverLease: true,
};

/**
 * URI schemes are case-insensitive, but hosted hubs only match the lower-case spelling, so
 * `BS://id` is returned as `bs://id`. Anything without the lower-case `scheme` returns undefined.
 */
export function canonicalSchemeReference(app: string, scheme: string): string | undefined {
  if (app.slice(0, scheme.length).toLowerCase() !== scheme) return undefined;
  return `${scheme}${app.slice(scheme.length)}`;
}
