import { describe, expect, expectTypeOf, test } from 'vitest';
import {
  getUnsupportedMacOsSettingMessage,
  isMacOsSettingSupported,
  MACOS_PERMISSION_TARGETS,
  MOBILE_PERMISSION_TARGETS,
  parsePermissionAction,
  parsePermissionTarget,
  PERMISSION_ACTIONS,
  PERMISSION_MODES,
  SETTINGS_INVALID_ARGS_MESSAGE,
  SETTINGS_MACOS_PERMISSION_USAGE,
  SETTINGS_USAGE_OVERRIDE,
  type PermissionAction,
  type PermissionTarget,
} from './settings.ts';

// Fixed expected data on purpose (#2614): this file is the witness that a shared permission
// declaration neither widened nor narrowed what any settings surface already accepted, and that it
// kept the accepted names in the order `settings` help has always listed them.
// The one deliberate widening is `all`, first in the list: the Maestro setPermissions merge
// needs it to travel as one `settings permission` call while each backend resolves it.
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

const SETTINGS_FORMS = [
  '<wifi|airplane|location> <on|off>',
  'location set <lat> <lon>',
  'animations <on|off>',
  'appearance <light|dark|toggle>',
  'faceid <match|nonmatch|enroll|unenroll>',
  'touchid <match|nonmatch|enroll|unenroll>',
  'fingerprint <match|nonmatch>',
  'clear-app-state [app-id]',
  'reset-keychain clear',
  `permission <grant|deny|reset> <${MOBILE_TARGETS.join('|')}> [full|limited]`,
  'permission <grant|reset> <accessibility|screen-recording|input-monitoring>',
] as const;

// The whole normalization the parsers promise, written out rather than sampled.
const NORMALIZATIONS = [
  (name: string) => name,
  (name: string) => name.toUpperCase(),
  (name: string) => name.charAt(0).toUpperCase() + name.slice(1),
  (name: string) => ` ${name} `,
  (name: string) => `\t${name}\n`,
] as const;

const REJECTED_TARGETS = [
  ...MACOS_ONLY_TARGETS,
  'bluetooth',
  'camera-x',
  'camera limited',
  '',
  '   ',
  undefined,
] as const;

function expectInvalidArgs(run: () => unknown, message: string): void {
  expect(run).toThrow(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      message: expect.stringContaining(message),
    }),
  );
}

describe('the declared permission vocabulary', () => {
  test('holds the names each surface already accepted, in help order', () => {
    expect([...MOBILE_PERMISSION_TARGETS]).toEqual([...MOBILE_TARGETS]);
    expect([...MACOS_PERMISSION_TARGETS]).toEqual([...MACOS_ONLY_TARGETS]);
    expect([...PERMISSION_ACTIONS]).toEqual(['grant', 'deny', 'reset']);
    expect([...PERMISSION_MODES]).toEqual(['full', 'limited']);
  });
});

describe('settings usage and error strings', () => {
  test('help lists every settings form in its documented order', () => {
    expect(SETTINGS_USAGE_OVERRIDE.split(' | ')).toEqual(
      SETTINGS_FORMS.map((form) => `settings ${form}`),
    );
  });

  test('the invalid-args message lists the same forms, with the last one as an alternative', () => {
    expect(SETTINGS_INVALID_ARGS_MESSAGE).toBe(
      `settings requires ${SETTINGS_FORMS.slice(0, -1).join(', ')}, or ${SETTINGS_FORMS.at(-1)}`,
    );
  });

  test('the macOS permission form keeps the actions it serves and the names it accepts', () => {
    expect(SETTINGS_MACOS_PERMISSION_USAGE).toBe(
      'permission <grant|reset> <accessibility|screen-recording|input-monitoring>',
    );
  });

  test('the macOS guidance names the permission form it supports', () => {
    expect(getUnsupportedMacOsSettingMessage('wifi')).toBe(
      'Unsupported macOS setting: wifi. macOS supports only settings appearance <light|dark|toggle> ' +
        'and settings permission <grant|reset> <accessibility|screen-recording|input-monitoring>. ' +
        'wifi|airplane|location|animations remain unsupported on macOS.',
    );
  });

  test('only appearance and permission are supported macOS settings', () => {
    expect(isMacOsSettingSupported(' Permission ')).toBe(true);
    expect(isMacOsSettingSupported('appearance')).toBe(true);
    expect(isMacOsSettingSupported('wifi')).toBe(false);
  });
});

describe('parsePermissionTarget', () => {
  test('accepts every mobile target under each normalization', () => {
    for (const target of MOBILE_TARGETS) {
      for (const normalize of NORMALIZATIONS) {
        expect(parsePermissionTarget(normalize(target))).toBe(target);
      }
    }
  });

  test('refuses every name outside the mobile vocabulary, including the macOS-only ones', () => {
    for (const target of REJECTED_TARGETS) {
      expectInvalidArgs(
        () => parsePermissionTarget(target),
        `permission setting requires a target: ${MOBILE_TARGETS.join('|')}`,
      );
    }
  });
});

describe('parsePermissionAction', () => {
  test('accepts each action under each normalization', () => {
    for (const action of ['grant', 'deny', 'reset']) {
      for (const normalize of NORMALIZATIONS) {
        expect(parsePermissionAction(normalize(action))).toBe(action);
      }
    }
  });

  test('refuses an action outside the vocabulary with the accepted list', () => {
    for (const action of ['allow', 'revoke', '', '   ', 'deny-me']) {
      expectInvalidArgs(
        () => parsePermissionAction(action),
        `Invalid permission action: ${action}. Use grant|deny|reset.`,
      );
    }
  });
});

// The shared declaration must not move either exported type: these pins are what the public
// client and the platform owners compile against today.
describe('permission vocabulary types', () => {
  test('the contract vocabulary stays the mobile subset', () => {
    expectTypeOf<PermissionTarget>().toEqualTypeOf<(typeof MOBILE_TARGETS)[number]>();
    expectTypeOf<PermissionAction>().toEqualTypeOf<'grant' | 'deny' | 'reset'>();
  });

  test('the mobile vocabulary does not grow the macOS-only names', () => {
    expectTypeOf<'accessibility'>().not.toMatchTypeOf<PermissionTarget>();
    expectTypeOf<'screen-recording'>().not.toMatchTypeOf<PermissionTarget>();
    expectTypeOf<'input-monitoring'>().not.toMatchTypeOf<PermissionTarget>();
  });
});
