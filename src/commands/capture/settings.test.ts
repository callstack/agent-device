import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { CliFlags } from '@agent-device/contracts/command';
import { TEXT_SIZE_CATEGORIES } from '@agent-device/contracts/settings';
import { PROPERTY_RUNS } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { formatCliOutput } from '../cli-output.ts';
import { settingsCliReader, settingsCommandFacet, settingsDaemonWriter } from './settings.ts';

const MOBILE_TARGETS = [
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

// Fixed expected data (#2614): the CLI's own permission vocabulary is written out here, so a shared
// declaration that widens, narrows, or reorders what this command accepts fails this file.
const PERMISSION_TARGETS = [...MOBILE_TARGETS, ...MACOS_ONLY_TARGETS];
const PERMISSION_TARGETS_MESSAGE = 'settings permission requires a permission target.';
const PERMISSION_MODES = ['full', 'limited'] as const;

function flags(): CliFlags {
  return {} as CliFlags;
}

function readGrant(permission: string): unknown {
  return settingsCliReader(['permission', 'grant', permission], flags());
}

function expectInvalidArgs(run: () => unknown, message: string): void {
  expect(run).toThrow(expect.objectContaining({ code: 'INVALID_ARGS', message }));
}

describe('settings CLI', () => {
  test('reads and writes settings input', () => {
    const input = settingsCliReader(['permission', 'grant', 'camera', 'limited'], flags());
    expect(input).toMatchObject({
      setting: 'permission',
      state: 'grant',
      permission: 'camera',
      mode: 'limited',
    });
    expect(settingsDaemonWriter(input)).toMatchObject({
      command: 'settings',
      positionals: ['permission', 'grant', 'camera', 'limited'],
    });
  });

  // #1796: the Android revoke warning rides `warnings`; the human CLI line must show it. The line is
  // appended by `formatCliOutput` (#2682), so that is where the guarantee is asserted; the formatter
  // itself only renders the response's own message.
  test('renders response warnings after the message', async () => {
    const warning = 'android.permission.CAMERA was granted before this revoke, and Android …';
    const response = {
      setting: 'permission',
      state: 'reset',
      message: 'Updated setting: permission',
      warnings: [warning],
    };

    const output = await formatCliOutput({ name: 'settings', input: {}, result: response });
    expect(output?.text).toBe(`Updated setting: permission\nWarning: ${warning}`);
    expect(output?.data).toMatchObject({ warnings: [warning] });

    const rendered = settingsCommandFacet.cliOutputFormatter!({ input: {}, result: response });
    expect(rendered.text).toBe('Updated setting: permission');
  });

  test('keeps the documented macOS permission form in the command detail', () => {
    expect(settingsCommandFacet.text.cliDetail).toContain(
      'settings permission <grant|reset> <accessibility|screen-recording|input-monitoring>',
    );
  });

  test('declares exactly the accepted permission modes on its input schema', () => {
    const mode = settingsCommandFacet.metadata.inputSchema.properties?.mode as
      | { enum?: unknown }
      | undefined;
    expect(mode?.enum).toEqual([...PERMISSION_MODES]);
  });
});

describe('settings CLI permission vocabulary', () => {
  test.each(PERMISSION_TARGETS)('accepts the %s permission target', (permission) => {
    expect(readGrant(permission)).toMatchObject({
      setting: 'permission',
      state: 'grant',
      permission,
    });
  });

  test('accepts every permission action', () => {
    for (const state of ['grant', 'deny', 'reset']) {
      expect(settingsCliReader(['permission', state, 'camera'], flags())).toMatchObject({
        setting: 'permission',
        state,
        permission: 'camera',
      });
    }
  });

  test('accepts each permission mode', () => {
    for (const mode of PERMISSION_MODES) {
      expect(settingsCliReader(['permission', 'grant', 'photos', mode], flags())).toMatchObject({
        permission: 'photos',
        mode,
      });
    }
  });

  test('rejects an unknown permission mode', () => {
    expectInvalidArgs(
      () => settingsCliReader(['permission', 'grant', 'photos', 'partial'], flags()),
      'settings permission mode must be full or limited.',
    );
  });

  test('rejects a permission mode that is not the exact spelling', () => {
    for (const mode of ['FULL', ' Limited ']) {
      expectInvalidArgs(
        () => settingsCliReader(['permission', 'grant', 'photos', mode], flags()),
        'settings permission mode must be full or limited.',
      );
    }
  });

  test('rejects a target outside the vocabulary without normalizing it', () => {
    for (const permission of ['CAMERA', ' all', 'location-always ']) {
      expectInvalidArgs(() => readGrant(permission), PERMISSION_TARGETS_MESSAGE);
    }
  });

  test('rejects an unknown permission action before reading a target', () => {
    expectInvalidArgs(
      () => settingsCliReader(['permission', 'allow', 'camera'], flags()),
      'Invalid settings arguments.',
    );
  });

  test('carries a macOS-only target and its mode to the daemon request', () => {
    const input = settingsCliReader(['permission', 'deny', 'screen-recording', 'full'], flags());
    expect(settingsDaemonWriter(input)).toMatchObject({
      command: 'settings',
      positionals: ['permission', 'deny', 'screen-recording', 'full'],
    });
  });
});

describe('settings CLI text-size', () => {
  const LADDER_MESSAGE = `Invalid text size: gigantic. Use ${TEXT_SIZE_CATEGORIES.join('|')}.`;

  test('reads with a lone positional and writes with a category', () => {
    expect(settingsCliReader(['text-size'], flags())).toMatchObject({ setting: 'text-size' });
    expect(settingsCliReader(['text-size'], flags())).not.toHaveProperty('state');
    expect(settingsDaemonWriter(settingsCliReader(['text-size'], flags()))).toMatchObject({
      command: 'settings',
      positionals: ['text-size'],
    });

    const write = settingsCliReader(['text-size', 'accessibility-large'], flags());
    expect(write).toMatchObject({ setting: 'text-size', state: 'accessibility-large' });
    expect(settingsDaemonWriter(write)).toMatchObject({
      command: 'settings',
      positionals: ['text-size', 'accessibility-large'],
    });
  });

  test.each([...TEXT_SIZE_CATEGORIES])('accepts the %s category', (category) => {
    expect(settingsCliReader(['text-size', category], flags())).toMatchObject({ state: category });
  });

  test('refuses an off-ladder category and lists the whole ladder', () => {
    expectInvalidArgs(() => settingsCliReader(['text-size', 'gigantic'], flags()), LADDER_MESSAGE);
  });

  test('publishes the read form in its usage', () => {
    expect(settingsCommandFacet.metadata.inputSchema.properties?.state).toBeDefined();
    expect(settingsCommandFacet.metadata.inputSchema.required).not.toContain('state');
    const usage = (settingsCommandFacet.cliSchema as { usageOverride: string }).usageOverride;
    expect(usage).toContain(`text-size [${TEXT_SIZE_CATEGORIES.join('|')}]`);
  });

  test('a category is accepted exactly when it names a ladder rung, any casing or padding', () => {
    // The deliberate contrast with `permission`, which refuses a target it would have to normalize:
    // a text size has one spelling per rung and `simctl`/`font_scale` both take the canonical one,
    // so the reader canonicalizes instead of refusing.
    fc.assert(
      fc.property(fc.string(), (value) => {
        const canonical = value.trim().toLowerCase();
        if ((TEXT_SIZE_CATEGORIES as readonly string[]).includes(canonical)) {
          expect(settingsCliReader(['text-size', value], flags())).toMatchObject({
            state: canonical,
          });
          return;
        }
        expect(() => settingsCliReader(['text-size', value], flags())).toThrow(
          expect.objectContaining({ code: 'INVALID_ARGS' }),
        );
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

describe('settings CLI permission membership properties', () => {
  test('a target is accepted exactly when it is spelled as a vocabulary name', () => {
    const vocabulary = new Set<string>(PERMISSION_TARGETS);
    fc.assert(
      fc.property(fc.string(), (value) => {
        if (vocabulary.has(value)) {
          expect(readGrant(value)).toMatchObject({ permission: value });
          return;
        }
        expectInvalidArgs(() => readGrant(value), PERMISSION_TARGETS_MESSAGE);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  test('case and padding never widen what a vocabulary name is accepted as', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PERMISSION_TARGETS),
        fc.boolean(),
        fc.boolean(),
        (name, uppercased, padded) => {
          const spelled = uppercased ? name.toUpperCase() : name;
          const value = padded ? ` ${spelled} ` : spelled;
          if (value === name) return;
          expectInvalidArgs(() => readGrant(value), PERMISSION_TARGETS_MESSAGE);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
