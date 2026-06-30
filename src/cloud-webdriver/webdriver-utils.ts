import type { DeviceLease } from '../daemon/lease-registry.ts';

export type LeaseValue<T> = T | ((lease: DeviceLease) => T);

export function resolveLeaseValue<T>(
  value: LeaseValue<T> | undefined,
  lease: DeviceLease,
): T | undefined {
  return typeof value === 'function' ? (value as (lease: DeviceLease) => T)(lease) : value;
}

export function basicAuthHeader(credentials: { username: string; accessKey: string }): string {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.accessKey}`).toString('base64')}`;
}

export function trimLeadingSlash(value: string): string {
  let firstNonSlash = 0;
  while (firstNonSlash < value.length && value.charCodeAt(firstNonSlash) === 47) {
    firstNonSlash += 1;
  }
  return firstNonSlash === 0 ? value : value.slice(firstNonSlash);
}

export function trimTrailingSlash(value: string): string {
  let lastNonSlash = value.length - 1;
  while (lastNonSlash >= 0 && value.charCodeAt(lastNonSlash) === 47) {
    lastNonSlash -= 1;
  }
  return lastNonSlash === value.length - 1 ? value : value.slice(0, lastNonSlash + 1);
}

export function withTrailingSlash(url: URL): URL {
  if (url.pathname.endsWith('/')) return url;
  const copy = new URL(url);
  copy.pathname = `${copy.pathname}/`;
  return copy;
}
