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

const MACOS_SURFACE_BACKENDS = {
  app: 'xctest',
  'frontmost-app': 'macos-helper',
  desktop: 'macos-helper',
  menubar: 'macos-helper',
} as const satisfies Record<SessionSurface, MacOsSurfaceBackend>;

/** An absent surface is an app session, the reading every route already gives it. */
export function macOsSurfaceBackend(surface: SessionSurface | undefined): MacOsSurfaceBackend {
  return MACOS_SURFACE_BACKENDS[surface ?? 'app'];
}

type HelperRoutedSurface = {
  [S in SessionSurface]: (typeof MACOS_SURFACE_BACKENDS)[S] extends 'macos-helper' ? S : never;
}[SessionSurface];

declare const helperSurface: unique symbol;
/** A surface the owner routed to the macOS helper; only `macOsHelperSurface` produces one. */
export type MacOsHelperSurface = HelperRoutedSurface & { readonly [helperSurface]: true };

export function macOsHelperSurface(
  surface: SessionSurface | undefined,
): MacOsHelperSurface | undefined {
  return surface !== undefined && macOsSurfaceBackend(surface) === 'macos-helper'
    ? (surface as MacOsHelperSurface)
    : undefined;
}
