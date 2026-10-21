import { describe, expect, expectTypeOf, test } from 'vitest';
import type {
  ActionButtonCommandOptions,
  AgentDeviceCommandClient,
  AppSwitcherCommandOptions,
  BackCommandOptions,
  FoldCommandOptions,
  HomeCommandOptions,
  OrientationCommandOptions,
  TelephonyCommandOptions,
  TvRemoteCommandOptions,
} from '../../client/client-types.ts';
import type { CommandResult } from '@agent-device/command-registry/command-result';
import { readInputFromCli } from '../cli-grammar/registry.ts';
import { findCommandMetadata } from '../command-metadata.ts';
import type { CliFlags } from '@agent-device/contracts/command';
import {
  backCliReader,
  backDaemonWriter,
  clipboardCliReader,
  clipboardDaemonWriter,
  foldCliReader,
  foldDaemonWriter,
  hardwareButtonCliReader,
  hardwareButtonDaemonWriter,
  keyboardCliReader,
  keyboardDaemonWriter,
  orientationCliReader,
  orientationDaemonWriter,
  telephonyCliReader,
  telephonyDaemonWriter,
  tvRemoteCliReader,
  tvRemoteDaemonWriter,
  systemCommandFamily,
} from './index.ts';
import { systemCliOutputFormatters } from './output.ts';

function flags(overrides: Partial<CliFlags> = {}): CliFlags {
  return overrides as CliFlags;
}

function expectInvalidArgs(fn: () => unknown, messageFragment: string) {
  expect(fn).toThrow(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      message: expect.stringContaining(messageFragment),
    }),
  );
}

describe('system command interface', () => {
  test('navigation commands declare the public client signatures', () => {
    expectTypeOf<AgentDeviceCommandClient['back']>().toEqualTypeOf<
      (options?: BackCommandOptions) => Promise<CommandResult<'back'>>
    >();
    expectTypeOf<AgentDeviceCommandClient['home']>().toEqualTypeOf<
      (options?: HomeCommandOptions) => Promise<CommandResult<'home'>>
    >();
    expectTypeOf<AgentDeviceCommandClient['orientation']>().toEqualTypeOf<
      (options: OrientationCommandOptions) => Promise<CommandResult<'orientation'>>
    >();
    expectTypeOf<AgentDeviceCommandClient['fold']>().toEqualTypeOf<
      (options: FoldCommandOptions) => Promise<CommandResult<'fold'>>
    >();
    expectTypeOf<AgentDeviceCommandClient['appSwitcher']>().toEqualTypeOf<
      (options?: AppSwitcherCommandOptions) => Promise<CommandResult<'app-switcher'>>
    >();
    expectTypeOf<AgentDeviceCommandClient['actionButton']>().toEqualTypeOf<
      (options?: ActionButtonCommandOptions) => Promise<CommandResult<'action-button'>>
    >();
    expectTypeOf<AgentDeviceCommandClient['tvRemote']>().toEqualTypeOf<
      (options: TvRemoteCommandOptions) => Promise<CommandResult<'tv-remote'>>
    >();
  });

  const parameterless = ['appstate', 'home', 'app-switcher', 'action-button'] as const;

  test('parameterless readers project common selection flags through', () => {
    for (const command of parameterless) {
      expect(systemCommandFamily.cliReaders[command]([], flags({ platform: 'ios' }))).toEqual({
        platform: 'ios',
      });
    }
  });

  test('parameterless daemon writers emit command names with no positionals', () => {
    for (const command of parameterless) {
      expect(
        systemCommandFamily.daemonWriters?.[command]?.(
          {},
          { env: process.env, cwd: process.cwd() },
        ),
      ).toMatchObject({
        command,
        positionals: [],
      });
    }
  });

  test('back reader and writer normalize back mode', () => {
    expect(backCliReader([], flags({ backMode: 'system' }))).toMatchObject({
      mode: 'system',
    });
    expect(backDaemonWriter({ mode: 'in-app' }).options).toMatchObject({
      backMode: 'in-app',
    });
    expect(
      (
        backDaemonWriter({ mode: 'teleport' } as unknown as Record<string, unknown>)
          .options as Record<string, unknown>
      ).backMode,
    ).toBeUndefined();
  });

  // #1638: --settle has to survive BOTH back seams — the reader seam that
  // builds the input (`readInputFromCli`, which merges the trait-derived
  // settle triple since #1652) and the writer that turns it into daemon
  // request options.
  test('back reader and writer carry the settle request through to daemon flags', () => {
    const input = readInputFromCli(
      'back',
      [],
      flags({ settle: true, settleQuietMs: 250, timeoutMs: 8_000 }),
    );
    expect(input).toMatchObject({ settle: true, settleQuietMs: 250, timeoutMs: 8_000 });
    expect(backDaemonWriter(input).options).toMatchObject({
      settle: true,
      settleQuietMs: 250,
      timeoutMs: 8_000,
    });
    expect(readInputFromCli('back', [], flags()).settle).toBeUndefined();
  });

  test('back CLI output renders the settled observation', () => {
    const output = systemCliOutputFormatters.back({
      env: process.env,
      input: {},
      result: {
        action: 'back',
        mode: 'in-app',
        message: 'Back',
        settle: {
          settled: true,
          waitedMs: 300,
          diff: {
            summary: { additions: 1, removals: 2, unchanged: 5 },
            lines: [
              { kind: 'removed', text: '@e9 [button] "Save"' },
              { kind: 'added', text: '@e3 [button] "Edit"', ref: 'e3' },
            ],
          },
        },
      },
    });

    expect(output.text).toBe(
      [
        'Back',
        'settled after 300ms: +1 -2 (~5 unchanged)',
        '- @e9 [button] "Save"',
        '+ @e3 [button] "Edit"',
      ].join('\n'),
    );
  });

  test('appstate CLI output renders the Apple session app from the runner read', () => {
    const output = systemCliOutputFormatters.appstate({
      env: process.env,
      input: {},
      result: {
        platform: 'ios',
        appName: 'TestApp',
        appBundleId: 'com.example.testapp',
        state: 'runningForeground',
        source: 'runner',
        surface: 'app',
      },
    });
    expect(output.text).toBe(
      [
        'Session app: TestApp',
        'Bundle: com.example.testapp',
        'State: runningForeground',
        'Source: runner',
      ].join('\n'),
    );
  });

  test('appstate CLI output falls back to the bundle id and omits absent lines', () => {
    const output = systemCliOutputFormatters.appstate({
      env: process.env,
      input: {},
      result: {
        platform: 'ios',
        appBundleId: 'com.example.mobile',
        source: 'session',
        surface: 'app',
      },
    });
    expect(output.text).toBe(
      ['Session app: com.example.mobile', 'Bundle: com.example.mobile', 'Source: session'].join(
        '\n',
      ),
    );
  });

  test('appstate CLI output renders unknown when the Apple session carries no app identity', () => {
    const output = systemCliOutputFormatters.appstate({
      env: process.env,
      input: {},
      result: { platform: 'ios', surface: 'app' },
    });
    expect(output.text).toBe('Session app: unknown');
  });

  test('appstate CLI output renders the Android foreground app and activity', () => {
    const output = systemCliOutputFormatters.appstate({
      env: process.env,
      input: {},
      result: {
        platform: 'android',
        package: 'com.example',
        activity: '.MainActivity',
      },
    });
    expect(output.text).toBe(['Foreground app: com.example', 'Activity: .MainActivity'].join('\n'));
  });

  test('appstate CLI output renders the macOS session app', () => {
    // macOS appState is never admitted by the Apple runtime facts, so the live
    // daemon always answers from the session record: no State line.
    const output = systemCliOutputFormatters.appstate({
      env: process.env,
      input: {},
      result: {
        platform: 'macos',
        appName: 'System Settings',
        appBundleId: 'com.apple.systempreferences',
        source: 'session',
        surface: 'app',
      },
    });
    expect(output.text).toBe(
      [
        'Session app: System Settings',
        'Bundle: com.apple.systempreferences',
        'Source: session',
      ].join('\n'),
    );
  });

  test('appstate CLI output renders the HarmonyOS foreground app and activity', () => {
    const output = systemCliOutputFormatters.appstate({
      env: process.env,
      input: {},
      result: {
        platform: 'harmonyos',
        package: 'com.example.hmapp',
        activity: 'EntryAbility',
      },
    });
    expect(output.text).toBe(
      ['Foreground app: com.example.hmapp', 'Activity: EntryAbility'].join('\n'),
    );
  });

  test('orientation reader and writer normalize orientation', () => {
    expect(orientationCliReader(['left'], flags())).toMatchObject({
      orientation: 'landscape-left',
    });
    expect(orientationDaemonWriter({ orientation: 'portrait' }).positionals).toEqual(['portrait']);
  });

  test('orientation reader and writer reject missing orientation', () => {
    expectInvalidArgs(
      () => orientationCliReader([], flags()),
      'orientation requires an orientation',
    );
    expectInvalidArgs(() => orientationDaemonWriter({}), 'orientation requires orientation');
  });

  test('fold reader and writer normalize the pose', () => {
    expect(foldCliReader(['book'], flags())).toMatchObject({ pose: 'half-open' });
    expect(foldCliReader(['Unfolded'], flags({ platform: 'ios' }))).toMatchObject({
      platform: 'ios',
      pose: 'open',
    });
    expect(foldDaemonWriter({ pose: 'closed' })).toMatchObject({
      command: 'fold',
      positionals: ['closed'],
    });
  });

  test('fold reader and writer reject a missing or unknown pose', () => {
    expectInvalidArgs(() => foldCliReader([], flags()), 'fold requires a pose');
    expectInvalidArgs(() => foldCliReader(['sideways'], flags()), 'Invalid fold pose');
    expectInvalidArgs(() => foldDaemonWriter({}), 'fold requires a pose');
  });

  test('keyboard reader maps aliases and validates arguments', () => {
    expect(keyboardCliReader(['get'], flags())).toMatchObject({ action: 'status' });
    expect(keyboardCliReader([], flags())).not.toHaveProperty('action');
    expectInvalidArgs(
      () => keyboardCliReader(['dismiss', 'extra'], flags()),
      'at most one action argument',
    );
    expectInvalidArgs(() => keyboardCliReader(['wiggle'], flags()), 'keyboard action must be');
  });

  test('keyboard writer forwards action when present', () => {
    expect(keyboardDaemonWriter({ action: 'dismiss' }).positionals).toEqual(['dismiss']);
    expect(keyboardDaemonWriter({}).positionals).toEqual([]);
  });

  test('clipboard reader parses read and write subcommands', () => {
    expect(clipboardCliReader(['read'], flags())).toMatchObject({ action: 'read' });
    expect(clipboardCliReader(['write', 'hello', 'world'], flags())).toMatchObject({
      action: 'write',
      text: 'hello world',
    });
  });

  test('clipboard reader rejects invalid subcommands', () => {
    expectInvalidArgs(() => clipboardCliReader([], flags()), 'read or write');
    expectInvalidArgs(
      () => clipboardCliReader(['read', 'oops'], flags()),
      'does not accept additional arguments',
    );
    expectInvalidArgs(
      () => clipboardCliReader(['write'], flags()),
      'clipboard write requires text',
    );
  });

  test('clipboard writer serializes read and write subcommands', () => {
    expect(clipboardDaemonWriter({ action: 'read' }).positionals).toEqual(['read']);
    expect(clipboardDaemonWriter({ action: 'write', text: 'copied' }).positionals).toEqual([
      'write',
      'copied',
    ]);
  });

  test('tv-remote reader parses button and optional press subcommand', () => {
    expect(tvRemoteCliReader(['down'], flags({ durationMs: 250 }))).toMatchObject({
      button: 'down',
      durationMs: 250,
    });
    expect(tvRemoteCliReader(['press', 'select'], flags())).toMatchObject({
      button: 'select',
    });
    expect(tvRemoteCliReader(['volume-down'], flags())).toMatchObject({ button: 'volume-down' });
    expect(
      tvRemoteDaemonWriter({ button: 'android-keycode:300' } as Record<string, unknown>)
        .positionals,
    ).toEqual(['android-keycode:300']);
    expect(tvRemoteCliReader(['ok'], flags())).toMatchObject({ button: 'select' });
    expect(tvRemoteCliReader(['center'], flags())).toMatchObject({ button: 'select' });
    expect(tvRemoteCliReader(['enter'], flags())).toMatchObject({ button: 'select' });
  });

  test('tv-remote reader maps longpress subcommand to duration preset', () => {
    expect(tvRemoteCliReader(['longpress', 'select'], flags())).toMatchObject({
      button: 'select',
      durationMs: 500,
    });
    expect(tvRemoteCliReader(['longpress', 'back'], flags({ durationMs: 900 }))).toMatchObject({
      button: 'back',
      durationMs: 900,
    });
  });

  test('tv-remote reader and writer validate button arguments', () => {
    expect(
      tvRemoteDaemonWriter({ button: 'right' } as Record<string, unknown>).positionals,
    ).toEqual(['right']);
    expectInvalidArgs(
      () => tvRemoteCliReader([], flags()),
      'tv-remote requires exactly one button',
    );
    expectInvalidArgs(
      () => tvRemoteCliReader(['press', 'left', 'extra'], flags()),
      'tv-remote requires exactly one button',
    );
    expectInvalidArgs(
      () => tvRemoteCliReader(['longpress', 'left', 'extra'], flags()),
      'tv-remote requires exactly one button',
    );
    expectInvalidArgs(() => tvRemoteCliReader(['blue'], flags()), 'button must be one of');
  });

  test('hardware-button reader and writer validate the button positional', () => {
    expect(hardwareButtonCliReader(['volume-up'], flags())).toMatchObject({ button: 'volume-up' });
    expect(hardwareButtonCliReader(['Volume-Down'], flags())).toMatchObject({
      button: 'volume-down',
    });
    expect(
      hardwareButtonDaemonWriter({ button: 'power' } as Record<string, unknown>).positionals,
    ).toEqual(['power']);
    expectInvalidArgs(() => hardwareButtonCliReader([], flags()), 'requires exactly one button');
    expectInvalidArgs(
      () => hardwareButtonCliReader(['volume-up', 'power'], flags()),
      'requires exactly one button',
    );
    // Exact names only: no aliases, and nothing reaches the daemon for an unknown name.
    expectInvalidArgs(() => hardwareButtonCliReader(['vol'], flags()), 'button must be one of');
    expectInvalidArgs(() => hardwareButtonCliReader(['media'], flags()), 'button must be one of');
    // The extended names read and write through the same seam as the original three.
    expect(hardwareButtonCliReader(['media-fast-forward'], flags())).toMatchObject({
      button: 'media-fast-forward',
    });
    expect(
      hardwareButtonDaemonWriter({ button: 'sleep' } as Record<string, unknown>).positionals,
    ).toEqual(['sleep']);
  });
});

test('fold keyframes survive CLI and daemon projection without a preset', () => {
  const keyframes = [
    { atMs: 0, angle: 0 },
    { atMs: 5000, angle: 180 },
  ];
  const input = foldCliReader([], flags({ keyframes: JSON.stringify(keyframes) }));
  expect(input).toMatchObject({ keyframes });
  expect(foldDaemonWriter(input)).toMatchObject({
    command: 'fold',
    positionals: [],
    options: { keyframes: JSON.stringify(keyframes) },
  });
  expect(() => foldCliReader(['open'], flags({ keyframes: JSON.stringify(keyframes) }))).toThrow();
});

test('the typed client exposes telephony with its closed result', () => {
  expectTypeOf<AgentDeviceCommandClient['telephony']>().toEqualTypeOf<
    (options: TelephonyCommandOptions) => Promise<CommandResult<'telephony'>>
  >();
});

test('the CLI reader parses each action and joins unquoted SMS words', () => {
  expect(telephonyCliReader(['call', '5551234'], flags({ platform: 'android' }))).toMatchObject({
    platform: 'android',
    action: 'call',
    number: '5551234',
  });
  expect(telephonyCliReader(['Accept', '5551234'], flags())).toMatchObject({ action: 'accept' });
  expect(telephonyCliReader(['cancel', '5551234'], flags())).toMatchObject({ action: 'cancel' });
  expect(telephonyCliReader(['sms', '5551234', 'Meet', 'at', '8'], flags())).toMatchObject({
    action: 'sms',
    number: '5551234',
    text: 'Meet at 8',
  });
});

test('the CLI reader refuses a malformed event', () => {
  expect(() => telephonyCliReader(['sms', '5551234'], flags())).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS', message: expect.stringContaining('text') }),
  );
  expect(() => telephonyCliReader(['call', 'abc'], flags())).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS', message: 'Invalid phone number: abc.' }),
  );
});

test('the daemon writer sends the SMS text as one positional, quotes and all', () => {
  const text = `Don't "stop" the stream`;
  expect(telephonyDaemonWriter({ action: 'sms', number: '5551234', text })).toMatchObject({
    command: 'telephony',
    positionals: ['sms', '5551234', text],
  });
  expect(telephonyDaemonWriter({ action: 'cancel', number: '5551234' })).toMatchObject({
    command: 'telephony',
    positionals: ['cancel', '5551234'],
  });
  expect(() => telephonyDaemonWriter({ action: 'call', number: '5551234', text: 'x' })).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS' }),
  );
});

test('structured input validates through the same parser as the CLI', () => {
  const metadata = findCommandMetadata('telephony');
  expect(metadata.readInput({ action: 'sms', number: '+15551234567', text: 'hi' })).toMatchObject({
    action: 'sms',
    number: '+15551234567',
    text: 'hi',
  });
  expect(() => metadata.readInput({ action: 'call', number: '555 1234' })).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS' }),
  );
  expect(metadata.inputSchema).toMatchObject({ required: ['action', 'number'] });
});
