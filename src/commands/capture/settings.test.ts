import { describe, expect, test } from 'vitest';
import type { CliFlags } from '@agent-device/contracts/command';
import { SETTING_NAMES, TEXT_SIZE_CATEGORIES } from '@agent-device/contracts/settings-catalog';
import { formatCliOutput } from '../cli-output.ts';
import { settingsCliReader, settingsCommandFacet, settingsDaemonWriter } from './settings.ts';

function flags(): CliFlags {
  return {} as CliFlags;
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

  test('lists every setting in its help and its input schema', () => {
    for (const name of SETTING_NAMES) {
      expect(settingsCommandFacet.text.cliDetail).toContain(`\n  ${name}: `);
    }
    const setting = settingsCommandFacet.metadata.inputSchema.properties?.setting as
      | { enum?: unknown }
      | undefined;
    expect(setting?.enum).toEqual(SETTING_NAMES);
  });
});

describe('settings CLI permission', () => {
  test('rejects an unknown permission mode', () => {
    expectInvalidArgs(
      () => settingsCliReader(['permission', 'grant', 'photos', 'partial'], flags()),
      'settings permission mode must be full|limited.',
    );
  });

  test('carries a macOS-only target to the daemon request', () => {
    const input = settingsCliReader(['permission', 'grant', 'screen-recording'], flags());
    expect(settingsDaemonWriter(input)).toMatchObject({
      command: 'settings',
      positionals: ['permission', 'grant', 'screen-recording'],
    });
  });

  test('refuses an action or mode the macOS target does not take', () => {
    expectInvalidArgs(
      () => settingsCliReader(['permission', 'deny', 'screen-recording'], flags()),
      'settings permission deny does not apply to screen-recording. Use grant|reset.',
    );
  });

  // #3179: an app-scoped change can name an app the session never opened. `app` is no CLI flag key,
  // so the request carries it as input the way a gesture payload does.
  test('carries --app on a permission grant to the daemon request input', () => {
    const input = settingsCliReader(['permission', 'grant', 'camera'], {
      targetApp: 'com.example.app',
    } as CliFlags);
    expect(input).toMatchObject({ app: 'com.example.app' });
    expect(settingsDaemonWriter(input)).toMatchObject({
      command: 'settings',
      positionals: ['permission', 'grant', 'camera'],
      input: { app: 'com.example.app' },
    });
  });

  test('reads mobile-data on|off and writes it as two positionals', () => {
    for (const state of ['on', 'off'] as const) {
      const input = settingsCliReader(['mobile-data', state], flags());
      expect(input).toEqual({ setting: 'mobile-data', state });
      expect(settingsDaemonWriter(input)).toMatchObject({
        command: 'settings',
        positionals: ['mobile-data', state],
      });
    }
  });

  test('forwards --app on mobile-data so the daemon refuses it instead of dropping it', () => {
    const input = settingsCliReader(['mobile-data', 'off'], {
      targetApp: 'com.example.app',
    } as CliFlags);
    expect(settingsDaemonWriter(input)).toMatchObject({
      positionals: ['mobile-data', 'off'],
      input: { app: 'com.example.app' },
    });
  });

  test('carries an app on an iOS location toggle to the daemon request input', () => {
    const input = settingsCliReader(['location', 'on'], {
      targetApp: 'com.example.app',
    } as CliFlags);
    expect(settingsDaemonWriter(input)).toMatchObject({
      positionals: ['location', 'on'],
      input: { app: 'com.example.app' },
    });
  });

  // r4176656835: the writer used to drop the app, so `location set ... --app X` ignored X silently.
  // It now forwards, and the daemon's device-level refusal answers it (handler test below).
  test('forwards the app on a location set to the device-level refusal', () => {
    const input = settingsCliReader(['location', 'set', '37.7', '-122.4'], {
      targetApp: 'com.example.app',
    } as CliFlags);
    expect(settingsDaemonWriter(input)).toMatchObject({
      positionals: ['location', 'set', '37.7', '-122.4'],
      input: { app: 'com.example.app' },
    });
  });

  // The parser strips a configured default before the reader runs, so a `--app` the reader sees was
  // typed on this invocation. A destructive clear must land on the app the caller named, never fall
  // through to the session app or pick one of two named apps.
  test('keeps a clear-app-state app positional and out of the request input', () => {
    const input = settingsCliReader(['clear-app-state', 'com.example.app'], flags());
    const writer = settingsDaemonWriter(input);
    expect(writer.positionals).toEqual(['clear-app-state', 'com.example.app']);
    expect(writer.input).toBeUndefined();
    expect(input).toMatchObject({ app: 'com.example.app' });
  });

  test.each([[['clear-app-state']], [['clear-app-state', 'clear']]])(
    'aims %j at the --app it names when no positional does',
    (positionals) => {
      const input = settingsCliReader(positionals, { targetApp: 'com.example.app' } as CliFlags);
      expect(settingsDaemonWriter(input).positionals).toEqual([
        'clear-app-state',
        'com.example.app',
      ]);
    },
  );

  test('accepts the same app named positionally and with --app', () => {
    const input = settingsCliReader(['clear-app-state', 'clear', 'com.example.app'], {
      targetApp: 'com.example.app',
    } as CliFlags);
    expect(settingsDaemonWriter(input).positionals).toEqual(['clear-app-state', 'com.example.app']);
  });

  test('refuses a clear-app-state that names two different apps', () => {
    expect(() =>
      settingsCliReader(['clear-app-state', 'com.example.app'], {
        targetApp: 'com.example.other',
      } as CliFlags),
    ).toThrow(/names two apps: com.example.app and com.example.other/);
  });

  test('passes a setting outside the catalog to the daemon, which refuses it', () => {
    expect(
      settingsDaemonWriter({ setting: 'bluetooth', state: 'on' } as unknown as Parameters<
        typeof settingsDaemonWriter
      >[0]),
    ).toMatchObject({ positionals: ['bluetooth', 'on'] });
  });

  test('omits the request input when no app is named', () => {
    expect(
      settingsDaemonWriter(settingsCliReader(['animations', 'off'], flags())).input,
    ).toBeUndefined();
  });

  test('accepts --app for its app-scoped settings', () => {
    expect(settingsCommandFacet.cliSchema.allowedFlags).toEqual(['targetApp']);
  });

  test('carries an app named through the client input to the daemon request input', () => {
    expect(
      settingsDaemonWriter({
        setting: 'permission',
        state: 'grant',
        permission: 'camera',
        app: 'com.example.app',
      }),
    ).toMatchObject({ input: { app: 'com.example.app' } });
  });
});

describe('settings CLI text-size', () => {
  const LADDER_MESSAGE = `Invalid text-size state: gigantic. Use ${TEXT_SIZE_CATEGORIES.join('|')}.`;

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

  test('refuses an off-ladder category and lists the whole ladder', () => {
    expectInvalidArgs(() => settingsCliReader(['text-size', 'gigantic'], flags()), LADDER_MESSAGE);
  });

  test('publishes the read form in its usage', () => {
    expect(settingsCommandFacet.metadata.inputSchema.properties?.state).toBeDefined();
    expect(settingsCommandFacet.metadata.inputSchema.required).not.toContain('state');
    const usage = (settingsCommandFacet.cliSchema as { usageOverride: string }).usageOverride;
    expect(usage).toContain(`text-size [${TEXT_SIZE_CATEGORIES.join('|')}]`);
  });
});
