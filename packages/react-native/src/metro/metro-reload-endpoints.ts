import { AppError } from '@agent-device/kernel/errors';
import type { MetroRuntimeHints } from './metro-types.ts';
import {
  resolveRuntimeServerUrl,
  trimRuntimeValue,
} from '@agent-device/host-kit/runtime-transport-hints';

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
  const parsed = /^\d+$/.test(String(value).trim()) ? Number(String(value).trim()) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new AppError('INVALID_ARGS', `Invalid Metro port: ${String(value)}. Use 1-65535.`);
  }
  return parsed;
}

// Explicit flags win over session runtime hints, which win over localhost:8081.
export function resolveMetroServerUrl(input: MetroReloadTargetInput): URL {
  const explicitBundleUrl = trimRuntimeValue(input.bundleUrl);
  const bundleUrl = explicitBundleUrl ?? input.runtime?.bundleUrl;
  const serverUrl = resolveRuntimeServerUrl({
    bundleUrl,
    metroHost:
      trimRuntimeValue(input.metroHost) ??
      (explicitBundleUrl ? undefined : trimRuntimeValue(input.runtime?.metroHost)) ??
      (bundleUrl ? undefined : DEFAULT_METRO_HOST),
    metroPort:
      input.metroPort !== undefined
        ? parsePort(input.metroPort, DEFAULT_METRO_PORT)
        : explicitBundleUrl
          ? undefined
          : (input.runtime?.metroPort ?? (bundleUrl ? undefined : DEFAULT_METRO_PORT)),
  });
  if (!serverUrl) {
    throw new AppError('INVALID_ARGS', 'Unable to resolve Metro host and port for reload.');
  }
  return serverUrl;
}

export function resolveMetroReloadEndpoints(input: MetroReloadTargetInput): MetroReloadEndpoints {
  const serverUrl = resolveMetroServerUrl(input);
  const prefix = serverUrl.pathname.replace(/\/+$/, '');
  const reloadUrl = new URL(serverUrl);
  reloadUrl.pathname = `${prefix}/reload`;
  const messageSocketUrl = new URL(serverUrl);
  messageSocketUrl.protocol = serverUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  messageSocketUrl.pathname = `${prefix}/message`;
  return { reloadUrl: reloadUrl.toString(), messageSocketUrl: messageSocketUrl.toString() };
}
