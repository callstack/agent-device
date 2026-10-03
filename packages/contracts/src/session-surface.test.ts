import { expect, test } from 'vitest';
import {
  SESSION_SURFACES,
  macOsHelperSurface,
  macOsSurfaceBackend,
  type MacOsSurfaceBackend,
  type SessionSurface,
} from './session-surface.ts';

const EXPECTED_BACKENDS: Record<SessionSurface, MacOsSurfaceBackend> = {
  app: 'xctest',
  'frontmost-app': 'macos-helper',
  desktop: 'macos-helper',
  menubar: 'macos-helper',
};

test.each([
  ...SESSION_SURFACES.map((surface) => [surface, EXPECTED_BACKENDS[surface]] as const),
  [undefined, 'xctest'] as const,
])('the macOS %s surface is served by %s', (surface, backend) => {
  expect(macOsSurfaceBackend(surface)).toBe(backend);
  expect(macOsHelperSurface(surface)).toBe(backend === 'macos-helper' ? surface : undefined);
});
