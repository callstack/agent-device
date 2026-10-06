import type { SnapshotBackend } from '@agent-device/kernel/snapshot';
import { defineStringEnum } from './string-enum.ts';

export const SESSION_SURFACES = ['app', 'frontmost-app', 'desktop', 'menubar'] as const;
export type SessionSurface = (typeof SESSION_SURFACES)[number];
const SESSION_SURFACE_ENUM = defineStringEnum(SESSION_SURFACES, {
  normalize: (raw) => raw.trim().toLowerCase(),
  message: (value) => `Invalid surface: ${value}. Use ${SESSION_SURFACES.join('|')}.`,
});

export function parseSessionSurface(value: string | undefined): SessionSurface {
  return SESSION_SURFACE_ENUM.parse(value);
}

/** The backend that serves every operation on a macOS surface. */
export type MacOsSurfaceBackend = Extract<SnapshotBackend, 'xctest' | 'macos-helper'>;

/**
 * Which backend drives a macOS app session. `xctest` is the runner under XCTest Automation Mode;
 * `native` drives the app through the macOS helper's accessibility actions and process-targeted
 * events, so the app can stay in the background and the user keeps the pointer.
 */
const MACOS_APP_BACKENDS = ['xctest', 'native'] as const;
export type MacOsAppBackend = (typeof MACOS_APP_BACKENDS)[number];
const MACOS_APP_BACKEND_ENV = 'AGENT_DEVICE_MACOS_APP_BACKEND';
const MACOS_APP_BACKEND_ENUM = defineStringEnum(MACOS_APP_BACKENDS, {
  normalize: (raw) => raw.trim().toLowerCase(),
  message: (value) =>
    `Invalid ${MACOS_APP_BACKEND_ENV}: ${value}. Use ${MACOS_APP_BACKENDS.join('|')}.`,
});

/** The host's app-session backend; unset selects `xctest`. */
export function readMacOsAppBackend(
  readEnvironment: (name: string) => string | undefined,
): MacOsAppBackend {
  const raw = readEnvironment(MACOS_APP_BACKEND_ENV);
  return raw === undefined || raw.trim() === '' ? 'xctest' : MACOS_APP_BACKEND_ENUM.parse(raw);
}

const MACOS_HELPER_SURFACE_BACKENDS = {
  'frontmost-app': 'macos-helper',
  desktop: 'macos-helper',
  menubar: 'macos-helper',
} as const satisfies Record<Exclude<SessionSurface, 'app'>, MacOsSurfaceBackend>;

/** An absent surface is an app session, the reading every route already gives it. */
export function macOsSurfaceBackend(
  surface: SessionSurface | undefined,
  appBackend: MacOsAppBackend,
): MacOsSurfaceBackend {
  const resolved = surface ?? 'app';
  if (resolved === 'app') return appBackend === 'native' ? 'macos-helper' : 'xctest';
  return MACOS_HELPER_SURFACE_BACKENDS[resolved];
}

declare const helperSurface: unique symbol;
/** A surface the owner routed to the macOS helper; only `macOsHelperSurface` produces one. */
export type MacOsHelperSurface = SessionSurface & { readonly [helperSurface]: true };

export function macOsHelperSurface(
  surface: SessionSurface | undefined,
  appBackend: MacOsAppBackend,
): MacOsHelperSurface | undefined {
  const resolved = surface ?? 'app';
  return macOsSurfaceBackend(resolved, appBackend) === 'macos-helper'
    ? (resolved as MacOsHelperSurface)
    : undefined;
}
