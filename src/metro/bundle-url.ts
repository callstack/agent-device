import { normalizeBaseUrl } from '../client/base-url.ts';

export function buildBundleUrl(
  baseUrl: string,
  platform: 'ios' | 'android',
  entryPath = 'index.bundle',
): string {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/${entryPath}`);
  url.searchParams.set('platform', platform);
  url.searchParams.set('dev', 'true');
  url.searchParams.set('minify', 'false');
  return url.toString();
}
