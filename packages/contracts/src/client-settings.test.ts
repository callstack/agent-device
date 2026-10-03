import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import type { SettingsUpdateOptions } from './client-settings.ts';

type Permission = Extract<SettingsUpdateOptions, { setting: 'permission' }>;

const MOBILE_TARGETS = [
  'all',
  'camera',
  'microphone',
  'photos',
  'contacts',
  'contacts-limited',
  'notifications',
  'calendar',
  'location',
  'location-always',
  'media-library',
  'motion',
  'reminders',
  'siri',
] as const;

const MACOS_ONLY_TARGETS = ['accessibility', 'screen-recording', 'input-monitoring'] as const;

// Fixed expected data (#2614): the public client vocabulary is written out here so a shared
// declaration can neither widen the accepted permission names nor drop the macOS-only ones.
// The one deliberate widening is `all`: the Maestro setPermissions merge needs it to travel
// as one `settings permission` call while each backend resolves it.
describe('public client permission vocabulary', () => {
  test('names exactly the app-scoped targets plus the macOS-only ones', () => {
    expectTypeOf<Permission['permission']>().toEqualTypeOf<
      (typeof MOBILE_TARGETS)[number] | (typeof MACOS_ONLY_TARGETS)[number]
    >();
  });

  test('does not name a permission the vocabulary does not declare', () => {
    expectTypeOf<'bluetooth'>().not.toMatchTypeOf<Permission['permission']>();
  });

  test('keeps the permission actions and modes it already declared', () => {
    expectTypeOf<Permission['state']>().toEqualTypeOf<'grant' | 'deny' | 'reset'>();
    expectTypeOf<Permission['mode']>().toEqualTypeOf<'full' | 'limited' | undefined>();
  });
});

/**
 * The client-facing vocabulary is a type surface. Deriving it from `settings.ts` must not put that
 * module, and with it `AppError`, on the client's runtime path — a value import here would load it.
 */
describe('public client settings cost no runtime module graph', () => {
  test('importing the client vocabulary never loads the settings contract', async () => {
    const loaded: string[] = [];
    vi.resetModules();
    vi.doMock('./settings.ts', () => {
      loaded.push('settings');
      return {};
    });

    await import('./client-settings.ts');

    vi.doUnmock('./settings.ts');
    expect(loaded).toEqual([]);
  });

  test('contributes no runtime export of its own to the client surface', async () => {
    await import('./client-settings.ts');
    expect(Object.keys(await import('./client-settings.ts'))).toEqual([]);
  });
});
