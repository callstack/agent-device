import { AppError } from '../kernel/errors.ts';
import type { MetroRuntimeHints } from './metro-types.ts';
import {
  resolveRuntimeTransportHints,
  type ResolvedRuntimeTransport,
} from '../utils/runtime-transport.ts';

const DEFAULT_METRO_HOST = 'localhost';
const DEFAULT_METRO_PORT = 8081;

// Expo apps load JS through this virtual entry; index.bundle fails on Expo dev servers.
export const EXPO_VIRTUAL_ENTRY_BUNDLE_PATH = '.expo/.virtual-metro-entry.bundle';

export type MetroReloadTargetInput = {
  metroHost?: string;
  metroPort?: number | string;
  bundleUrl?: string;
  runtime?: MetroRuntimeHints;
};

export type MetroReloadEndpoints = {
  reloadUrl: string;
  messageSocketUrl: string;
};

export function parsePort(value: number | string | undefined, fallback: number): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new AppError('INVALID_ARGS', `Invalid Metro port: ${String(value)}. Use 1-65535.`);
  }
  return parsed;
}

// Explicit flags win over session runtime hints, which win over the localhost:8081 default.
export function resolveMetroReloadEndpoints(input: MetroReloadTargetInput): MetroReloadEndpoints {
  const explicitBundleUrl = normalizeOptionalString(input.bundleUrl);
  const bundleUrl = explicitBundleUrl ?? input.runtime?.bundleUrl;
  const hasExplicitBundleUrl = Boolean(explicitBundleUrl);
  const hasBundleUrl = Boolean(normalizeOptionalString(bundleUrl));
  const transport = resolveRuntimeTransportHints({
    metroHost: resolveReloadMetroHost(input, hasExplicitBundleUrl, hasBundleUrl),
    metroPort: resolveReloadMetroPort(input, hasExplicitBundleUrl, hasBundleUrl),
    bundleUrl,
  });
  if (!transport) {
    throw new AppError('INVALID_ARGS', 'Unable to resolve Metro host and port for reload.');
  }
  const prefix = resolveMetroEndpointPathPrefix(bundleUrl);
  return {
    reloadUrl: buildDevServerEndpointUrl(transport, transport.scheme, `${prefix}/reload`),
    messageSocketUrl: buildDevServerEndpointUrl(
      transport,
      transport.scheme === 'https' ? 'wss' : 'ws',
      `${prefix}/message`,
    ),
  };
}

function resolveReloadMetroHost(
  input: MetroReloadTargetInput,
  hasExplicitBundleUrl: boolean,
  hasBundleUrl: boolean,
): string | undefined {
  return (
    normalizeOptionalString(input.metroHost) ??
    (hasExplicitBundleUrl ? undefined : normalizeOptionalString(input.runtime?.metroHost)) ??
    (hasBundleUrl ? undefined : DEFAULT_METRO_HOST)
  );
}

function resolveReloadMetroPort(
  input: MetroReloadTargetInput,
  hasExplicitBundleUrl: boolean,
  hasBundleUrl: boolean,
): number | undefined {
  if (input.metroPort !== undefined) {
    return parsePort(input.metroPort, DEFAULT_METRO_PORT);
  }
  if (hasExplicitBundleUrl) {
    return undefined;
  }
  return input.runtime?.metroPort ?? (hasBundleUrl ? undefined : DEFAULT_METRO_PORT);
}

// Dev-server endpoints (/reload, /message) are siblings of the bundle entry, so the endpoint
// path keeps the bundle URL's mount prefix (e.g. /tenant-42/index.bundle -> /tenant-42/reload)
// instead of collapsing every prefixed URL to the bare host root. The Expo virtual entry
// (.expo/.virtual-metro-entry.bundle) is an entry-module path, not a server mount, so only the
// prefix before it survives.
function resolveMetroEndpointPathPrefix(bundleUrl: string | undefined): string {
  const value = normalizeOptionalString(bundleUrl);
  if (!value) return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return '';
  }
  const bundlePath = url.pathname.replace(/\/+$/, '');
  const virtualEntrySuffix = `/${EXPO_VIRTUAL_ENTRY_BUNDLE_PATH}`;
  if (bundlePath.endsWith(virtualEntrySuffix)) {
    return bundlePath.slice(0, -virtualEntrySuffix.length);
  }
  const lastSlash = bundlePath.lastIndexOf('/');
  const filename = lastSlash >= 0 ? bundlePath.slice(lastSlash + 1) : bundlePath;
  if (!filename.endsWith('.bundle')) return '';
  return lastSlash > 0 ? bundlePath.slice(0, lastSlash) : '';
}

function buildDevServerEndpointUrl(
  transport: ResolvedRuntimeTransport,
  scheme: 'http' | 'https' | 'ws' | 'wss',
  pathName: string,
): string {
  const url = new URL(`${scheme}://localhost`);
  url.hostname = transport.host;
  url.port = String(transport.port);
  url.pathname = pathName;
  return url.toString();
}

function normalizeOptionalString(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined;
}
