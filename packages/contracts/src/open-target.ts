export function isDeepLinkTarget(input: string): boolean {
  const value = input.trim();
  if (!value) return false;
  if (/\s/.test(value)) return false;
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):(.+)$/.exec(value);
  if (!match) return false;
  const scheme = match[1]?.toLowerCase();
  const rest = match[2] ?? '';
  if (
    scheme === 'http' ||
    scheme === 'https' ||
    scheme === 'ws' ||
    scheme === 'wss' ||
    scheme === 'ftp' ||
    scheme === 'ftps'
  ) {
    return rest.startsWith('//');
  }
  return true;
}

export function isWebUrl(input: string): boolean {
  const scheme = input.trim().split(':')[0]?.toLowerCase();
  return scheme === 'http' || scheme === 'https';
}

export const IOS_SAFARI_BUNDLE_ID = 'com.apple.mobilesafari';

export function resolveIosDeviceDeepLinkBundleId(
  appBundleId: string | undefined,
  url: string,
): string | undefined {
  const bundleId = appBundleId?.trim();
  if (bundleId) return bundleId;
  if (isWebUrl(url)) return IOS_SAFARI_BUNDLE_ID;
  return undefined;
}
