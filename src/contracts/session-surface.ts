import { defineStringEnum } from '../utils/string-enum.ts';

export const SESSION_SURFACES = ['app', 'frontmost-app', 'desktop', 'menubar'] as const;
export type SessionSurface = (typeof SESSION_SURFACES)[number];
const SESSION_SURFACE_ENUM = defineStringEnum(SESSION_SURFACES, {
  normalize: (raw) => raw.trim().toLowerCase(),
  message: (value) => `Invalid surface: ${value}. Use ${SESSION_SURFACES.join('|')}.`,
});

export function parseSessionSurface(value: string | undefined): SessionSurface {
  return SESSION_SURFACE_ENUM.parse(value);
}
