import { expect, test } from 'vitest';
import {
  SESSION_SURFACES,
  macOsHelperSurface,
  macOsSurfaceBackend,
  readMacOsAppBackend,
  type MacOsAppBackend,
  type MacOsSurfaceBackend,
  type SessionSurface,
} from './session-surface.ts';

const EXPECTED_BACKENDS: Record<MacOsAppBackend, Record<SessionSurface, MacOsSurfaceBackend>> = {
  xctest: {
    app: 'xctest',
    'frontmost-app': 'macos-helper',
    desktop: 'macos-helper',
    menubar: 'macos-helper',
  },
  native: {
    app: 'macos-helper',
    'frontmost-app': 'macos-helper',
    desktop: 'macos-helper',
    menubar: 'macos-helper',
  },
};

test.each(
  (['xctest', 'native'] as const).flatMap((appBackend) => [
    ...SESSION_SURFACES.map(
      (surface) => [appBackend, surface, EXPECTED_BACKENDS[appBackend][surface]] as const,
    ),
    [appBackend, undefined, EXPECTED_BACKENDS[appBackend].app] as const,
  ]),
)(
  'with the %s app backend the macOS %s surface is served by %s',
  (appBackend, surface, backend) => {
    expect(macOsSurfaceBackend(surface, appBackend)).toBe(backend);
    expect(macOsHelperSurface(surface, appBackend)).toBe(
      backend === 'macos-helper' ? (surface ?? 'app') : undefined,
    );
  },
);

test.each([
  [undefined, 'xctest'],
  ['', 'xctest'],
  ['native', 'native'],
  [' Native ', 'native'],
  ['xctest', 'xctest'],
] as const)('AGENT_DEVICE_MACOS_APP_BACKEND=%j selects %s', (raw, expected) => {
  expect(
    readMacOsAppBackend((name) => {
      expect(name).toBe('AGENT_DEVICE_MACOS_APP_BACKEND');
      return raw;
    }),
  ).toBe(expected);
});

test('an unknown app backend is refused instead of falling back', () => {
  expect(() => readMacOsAppBackend(() => 'vision')).toThrow(/AGENT_DEVICE_MACOS_APP_BACKEND/);
});
