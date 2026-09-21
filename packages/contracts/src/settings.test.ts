import { describe, expect, expectTypeOf, test } from 'vitest';
import { READABLE_SETTINGS } from './platform-runtime-operations.ts';
import {
  describeSettingRead,
  describeSettingWrite,
  getUnsupportedMacOsSettingMessage,
  isMacOsSettingSupported,
  MACOS_PERMISSION_TARGETS,
  MOBILE_PERMISSION_TARGETS,
  parsePermissionAction,
  parsePermissionTarget,
  parseTextSizeCategory,
  PERMISSION_ACTIONS,
  PERMISSION_MODES,
  readTextSizeCategory,
  SETTINGS_INVALID_ARGS_MESSAGE,
  SETTINGS_MACOS_PERMISSION_USAGE,
  SETTINGS_USAGE_OVERRIDE,
  TEXT_SIZE_CATEGORIES,
  textSizeSettingPayload,
  type PermissionAction,
  type PermissionTarget,
  type ReadableSetting,
  type TextSizeCategory,
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

// Fixed expected data on purpose: the ladder the `settings text-size` surface publishes, in the
// order help lists it. A rung added, dropped, or reordered fails the usage pins below.
const TEXT_SIZE_LADDER = [
  'extra-small',
  'small',
  'medium',
  'large',
  'extra-large',
  'extra-extra-large',
  'extra-extra-extra-large',
  'accessibility-medium',
  'accessibility-large',
  'accessibility-extra-large',
  'accessibility-extra-extra-large',
  'accessibility-extra-extra-extra-large',
] as const;

const SETTINGS_FORMS = [
  '<wifi|airplane|location> <on|off>',
  'location set <lat> <lon>',
  'animations <on|off>',
  'appearance <light|dark|toggle>',
  `text-size [${TEXT_SIZE_LADDER.join('|')}]`,
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
        'wifi|airplane|location|animations|text-size remain unsupported on macOS.',
    );
  });

  test('only appearance and permission are supported macOS settings', () => {
    expect(isMacOsSettingSupported(' Permission ')).toBe(true);
    expect(isMacOsSettingSupported('appearance')).toBe(true);
    expect(isMacOsSettingSupported('wifi')).toBe(false);
    expect(isMacOsSettingSupported('text-size')).toBe(false);
  });
});

describe('text-size vocabulary', () => {
  test('the ladder holds the rungs iOS exposes, in size order', () => {
    expect([...TEXT_SIZE_CATEGORIES]).toEqual([...TEXT_SIZE_LADDER]);
    expectTypeOf<TextSizeCategory>().toEqualTypeOf<(typeof TEXT_SIZE_LADDER)[number]>();
  });

  test('every rung parses under each normalization', () => {
    for (const category of TEXT_SIZE_LADDER) {
      for (const normalize of NORMALIZATIONS) {
        expect(parseTextSizeCategory(normalize(category))).toBe(category);
        expect(readTextSizeCategory(normalize(category))).toBe(category);
      }
    }
  });

  test('parseTextSizeCategory refuses an off-ladder value with the whole ladder', () => {
    // `simctl ui <device> content_size <bogus>` answers "Invalid argument" and exits 0, so refusing
    // here is the only thing that keeps a mistyped rung from being reported as applied.
    for (const value of ['gigantic', '', '   ', 'larger', 'extra_large']) {
      expectInvalidArgs(
        () => parseTextSizeCategory(value),
        `Invalid text size: ${value}. Use ${TEXT_SIZE_LADDER.join('|')}.`,
      );
    }
    expect(readTextSizeCategory('gigantic')).toBeUndefined();
    expect(readTextSizeCategory(undefined)).toBeUndefined();
  });

  test('the read payload names the setting that answered, beside the platform value', () => {
    const payload = textSizeSettingPayload('accessibility-large', '1.75');
    expect(payload).toEqual({
      setting: 'text-size',
      category: 'accessibility-large',
      platformValue: '1.75',
    });
    // Owners build the payload through this builder; a frozen result is what stops one from
    // widening the payload the response is composed from.
    expect(Object.isFrozen(payload)).toBe(true);
  });

  test('each leg answers with the sentence its setting owns', () => {
    // The response text is a claim about the setting, so it is composed here rather than at the call
    // site that happens to run the request.
    expect(describeSettingRead(textSizeSettingPayload('large', 'Small'))).toBe(
      'Text size is large',
    );
    expect(describeSettingWrite('text-size', 'large', undefined)).toBe('Text size set to large');
    expect(describeSettingWrite('clear-app-state', 'clear', 'com.example.app')).toBe(
      'Cleared user data for com.example.app',
    );
    expect(describeSettingWrite('wifi', 'on', undefined)).toBe('Updated setting: wifi');
  });
});

test('the readable-setting vocabulary is the names the read leg answers', () => {
  // The type is the vocabulary; `READABLE_SETTINGS` beside it is the value the CLI hub evaluates.
  // Both directions are pinned where the value is declared, so this is the one direction that has to
  // be read: a name that joins the type without joining the value is a compile error there.
  const readable: readonly ReadableSetting[] = READABLE_SETTINGS;
  expect(readable).toEqual(['text-size']);
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
