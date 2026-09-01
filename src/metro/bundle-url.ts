import { normalizeBaseUrl } from '../client/base-url.ts';
export function buildBundleUrl(
  baseUrl: string,
  platform: 'ios' | 'android',
  entryPath = 'index.bundle',
): string {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/${entryPath}`);
  const query = { platform, dev: 'true', minify: 'false' };
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}
