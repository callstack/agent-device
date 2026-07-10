export function normalizeBaseUrl(input: string): string {
  let end = input.length;
  while (end > 0 && input.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === input.length ? input : input.slice(0, end);
}

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
