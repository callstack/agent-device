import { describe, expect, test } from 'vitest';
import {
  describeSettingRead,
  describeSettingWrite,
  parseAppearanceAction,
  parsePermissionAction,
  parsePermissionTarget,
  parseSettingsMutation,
  parseSettingState,
  parseTextSizeCategory,
  readTextSizeCategory,
  settingsAppNotConsumedRefusal,
  settingsAppScope,
  settingsHelpLines,
  SETTINGS_APP_NOT_CONSUMED_REASON,
  SETTINGS_INVALID_ARGS_MESSAGE,
  SETTINGS_USAGE_OVERRIDE,
  textSizeSettingPayload,
} from './settings.ts';
import {
  MOBILE_PERMISSION_TARGETS,
  SETTING_NAMES,
  TEXT_SIZE_CATEGORIES,
} from './settings-catalog.ts';

const NORMALIZATIONS = [
  (name: string) => name,
  (name: string) => name.toUpperCase(),
  (name: string) => ` ${name} `,
] as const;

function expectInvalidArgs(run: () => unknown, message: string): void {
  expect(run).toThrow(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      message: expect.stringContaining(message),
    }),
  );
}

describe('settings usage', () => {
  test('folds settings that share a form into one line', () => {
    expect(SETTINGS_USAGE_OVERRIDE.split(' | ')).toEqual([
      'settings <wifi|airplane|mobile-data|location|animations> <on|off>',
      'settings location set <lat> <lon>',
      'settings appearance <light|dark|toggle>',
      `settings text-size [${TEXT_SIZE_CATEGORIES.join('|')}]`,
      'settings <faceid|touchid> <match|nonmatch|enroll|unenroll>',
      'settings fingerprint <match|nonmatch>',
      'settings clear-app-state [app-id]',
      'settings reset-keychain clear',
      `settings permission <grant|deny|reset> <${MOBILE_PERMISSION_TARGETS.join('|')}> [full|limited]`,
      'settings permission <grant|reset> <accessibility|screen-recording|input-monitoring>',
    ]);
  });

  test('the invalid-args message lists the same forms, with the last one as an alternative', () => {
    expect(SETTINGS_INVALID_ARGS_MESSAGE).toMatch(
      /^settings requires <wifi\|airplane\|mobile-data\|location\|animations> <on\|off>, .*, or permission <grant\|reset> <accessibility\|screen-recording\|input-monitoring>$/,
    );
  });

  test('help has one line per setting', () => {
    expect(settingsHelpLines().map((line) => line.split(':')[0])).toEqual(SETTING_NAMES);
  });
});

describe('parseSettingsMutation', () => {
  test('accepts every on/off spelling and normalizes names and states', () => {
    expect(parseSettingsMutation(['WiFi', 'ON'])).toEqual({ setting: 'wifi', state: 'on' });
    expect(parseSettingsMutation(['airplane', '0'])).toEqual({ setting: 'airplane', state: 'off' });
    expect(parseSettingsMutation(['wifi', ' true '])).toEqual({ setting: 'wifi', state: 'on' });
  });

  test('refuses a state outside a choice with the accepted states', () => {
    expectInvalidArgs(
      () => parseSettingsMutation(['appearance', 'bright']),
      'Invalid appearance state: bright. Use light|dark|toggle.',
    );
    expectInvalidArgs(
      () => parseSettingsMutation(['wifi']),
      'settings wifi requires a state: on|off.',
    );
  });

  test('refuses an unknown setting and extra positionals with the usage', () => {
    expectInvalidArgs(
      () => parseSettingsMutation(['bluetooth', 'on']),
      SETTINGS_INVALID_ARGS_MESSAGE,
    );
    expectInvalidArgs(
      () => parseSettingsMutation(['reset-keychain', 'clear', 'extra']),
      SETTINGS_INVALID_ARGS_MESSAGE,
    );
  });

  test('location set carries its coordinates as written', () => {
    expect(parseSettingsMutation(['location', 'set', '37.33', '-122.03'])).toEqual({
      setting: 'location',
      state: 'set',
      latitude: '37.33',
      longitude: '-122.03',
    });
    expectInvalidArgs(
      () => parseSettingsMutation(['location', 'set', '37.33']),
      'settings requires',
    );
  });

  test('permission takes a mobile or macOS target and an optional mode', () => {
    expect(parseSettingsMutation(['permission', 'grant', 'Photos', 'LIMITED'])).toEqual({
      setting: 'permission',
      state: 'grant',
      permission: 'photos',
      mode: 'limited',
    });
    expect(parseSettingsMutation(['permission', 'reset', 'accessibility'])).toMatchObject({
      permission: 'accessibility',
    });
    expectInvalidArgs(
      () => parseSettingsMutation(['permission', 'grant', 'bluetooth']),
      'settings permission requires a target:',
    );
    expectInvalidArgs(
      () => parseSettingsMutation(['permission', 'grant', 'photos', 'some']),
      'settings permission mode must be full|limited.',
    );
  });

  test('a permission target takes only the actions and modes of its own form', () => {
    expectInvalidArgs(
      () => parseSettingsMutation(['permission', 'deny', 'accessibility']),
      'settings permission deny does not apply to accessibility. Use grant|reset.',
    );
    expectInvalidArgs(
      () => parseSettingsMutation(['permission', 'grant', 'accessibility', 'full']),
      'settings permission accessibility takes no mode.',
    );
  });

  test('clear-app-state reads its app with or without the clear word', () => {
    expect(parseSettingsMutation(['clear-app-state', 'com.Example.App'])).toEqual({
      setting: 'clear-app-state',
      state: 'clear',
      app: 'com.Example.App',
    });
    expect(parseSettingsMutation(['clear-app-state', 'clear', 'com.example.app'])).toMatchObject({
      app: 'com.example.app',
    });
    expect(parseSettingsMutation(['clear-app-state'])).toEqual({
      setting: 'clear-app-state',
      state: 'clear',
    });
    expectInvalidArgs(
      () => parseSettingsMutation(['clear-app-state', 'com.example.app', 'typo']),
      SETTINGS_INVALID_ARGS_MESSAGE,
    );
  });
});

describe('text-size', () => {
  test('every rung parses under each normalization; an off-ladder value is refused', () => {
    for (const category of TEXT_SIZE_CATEGORIES) {
      for (const normalize of NORMALIZATIONS) {
        expect(parseTextSizeCategory(normalize(category))).toBe(category);
      }
    }
    expectInvalidArgs(() => parseTextSizeCategory('gigantic'), 'Invalid text-size state: gigantic');
    expect(readTextSizeCategory('gigantic')).toBeUndefined();
  });

  test('the read payload is frozen and each leg answers with its sentence', () => {
    const payload = textSizeSettingPayload('accessibility-large', '1.75');
    expect(payload).toEqual({
      setting: 'text-size',
      category: 'accessibility-large',
      platformValue: '1.75',
    });
    expect(Object.isFrozen(payload)).toBe(true);
    expect(describeSettingRead(payload)).toBe('Text size is accessibility-large');
    expect(describeSettingWrite('text-size', 'large', undefined)).toBe('Text size set to large');
    expect(describeSettingWrite('clear-app-state', 'clear', 'com.example.app')).toBe(
      'Cleared user data for com.example.app',
    );
    expect(describeSettingWrite('wifi', 'on', undefined)).toBe('Updated setting: wifi');
  });
});

describe('owner parsers', () => {
  test('parsePermissionTarget accepts the mobile targets only', () => {
    expect(parsePermissionTarget(' Camera ')).toBe('camera');
    expectInvalidArgs(
      () => parsePermissionTarget('accessibility'),
      `permission setting requires a target: ${MOBILE_PERMISSION_TARGETS.join('|')}`,
    );
  });

  test('parsePermissionAction and parseAppearanceAction name the accepted list', () => {
    expect(parsePermissionAction('DENY')).toBe('deny');
    expectInvalidArgs(() => parsePermissionAction('allow'), 'Use grant|deny|reset.');
    expect(parseAppearanceAction('Dark')).toBe('dark');
    expectInvalidArgs(() => parseAppearanceAction('bright'), 'Use light|dark|toggle.');
  });

  test('parseSettingState maps on/off spellings in any casing or padding', () => {
    for (const state of ['on', 'true', 'TRUE', '1', ' on ']) {
      expect(parseSettingState(state)).toBe(true);
    }
    for (const state of ['off', 'false', 'FALSE', '0'])
      expect(parseSettingState(state)).toBe(false);
    for (const state of ['maybe', '']) {
      expectInvalidArgs(() => parseSettingState(state), `Invalid setting state: ${state}`);
    }
  });
});

describe('settingsAppScope', () => {
  test.each([
    ['apple', 'permission', 'grant', 'app-scoped'],
    ['mobile', 'permission', 'deny', 'app-scoped'],
    ['macos-host', 'permission', 'grant', 'device-level'],
    ['apple', 'clear-app-state', 'clear', 'app-scoped'],
    ['mobile', 'clear-app-state', 'clear', 'app-scoped'],
    ['macos-host', 'clear-app-state', 'clear', 'unknown'],
    ['apple', 'location', 'on', 'app-scoped'],
    ['apple', 'location', '0', 'app-scoped'],
    ['mobile', 'location', 'TRUE', 'device-level'],
    ['apple', 'location', ' on ', 'app-scoped'],
    ['apple', 'location', 'set', 'device-level'],
    ['macos-host', 'location', 'set', 'unknown'],
    ['macos-host', 'location', 'on', 'unknown'],
    ['mobile', 'location', 'sideways', 'unknown'],
    ['apple', 'location', undefined, 'unknown'],
    ['mobile', 'wifi', 'on', 'unknown'],
    ['apple', ' PERMISSION ', 'GRANT', 'app-scoped'],
  ] as const)('%s %s %s is %s', (family, setting, state, scope) => {
    expect(settingsAppScope(family, setting, state)).toBe(scope);
  });
});

describe('settingsAppScope mobile-data', () => {
  test('mobile-data switches the whole device wherever it is served', () => {
    expect(settingsAppScope('mobile', 'mobile-data', 'on')).toBe('device-level');
    expect(settingsAppScope('mobile', 'mobile-data', 'off')).toBe('device-level');
    // No Apple target serves it; its refusal belongs to the leaf, not to the app.
    expect(settingsAppScope('apple', 'mobile-data', 'on')).toBe('unknown');
    expect(settingsAppScope('macos-host', 'mobile-data', 'on')).toBe('unknown');
  });
});

describe('settingsAppNotConsumedRefusal', () => {
  test('refuses by naming the mutation and quoting the app back', () => {
    const refusal = settingsAppNotConsumedRefusal('location', 'on', 'com.example.app');
    expect(refusal.code).toBe('INVALID_ARGS');
    expect(refusal.message).toContain('settings location on');
    expect(refusal.message).toContain('com.example.app');
    expect(refusal.details.reason).toBe(SETTINGS_APP_NOT_CONSUMED_REASON);
    expect(refusal.details.dispatched).toBe('no');
    expect(refusal.details.app).toBe('com.example.app');
    expect(refusal.hint).toContain('settings permission grant location --app com.example.app');
  });

  test('a stateless mutation is named by its setting alone', () => {
    expect(
      settingsAppNotConsumedRefusal('permission', undefined, 'com.example.app').message,
    ).toContain('settings permission applies to the target itself');
  });
});
