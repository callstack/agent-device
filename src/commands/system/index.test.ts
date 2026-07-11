import { describe, expect, expectTypeOf, test } from 'vitest';
import type {
  AgentDeviceCommandClient,
  AppSwitcherCommandOptions,
  BackCommandOptions,
  RotateCommandOptions,
  TvRemoteCommandOptions,
} from '../../client/client-types.ts';
import type { CommandResult } from '../../core/command-descriptor/command-result.ts';
import type { CliFlags } from '../cli-grammar/flag-types.ts';
import {
  appStateCliReader,
  appStateDaemonWriter,
  appSwitcherCliReader,
  appSwitcherDaemonWriter,
  backCliReader,
  backDaemonWriter,
  clipboardCliReader,
  clipboardDaemonWriter,
  homeCliReader,
  homeDaemonWriter,
  keyboardCliReader,
  keyboardDaemonWriter,
  rotateCliReader,
  rotateDaemonWriter,
  tvRemoteCliReader,
  tvRemoteDaemonWriter,
  systemCommandFamily,
} from './index.ts';

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
  test('navigation executable contracts project the public client signatures', () => {
    expectTypeOf<AgentDeviceCommandClient['back']>().toEqualTypeOf<
      (options?: BackCommandOptions) => Promise<CommandResult<'back'>>
    >();
    expectTypeOf<AgentDeviceCommandClient['rotate']>().toEqualTypeOf<
      (options: RotateCommandOptions) => Promise<CommandResult<'rotate'>>
    >();
    expectTypeOf<AgentDeviceCommandClient['appSwitcher']>().toEqualTypeOf<
      (options?: AppSwitcherCommandOptions) => Promise<CommandResult<'app-switcher'>>
    >();
    expectTypeOf<AgentDeviceCommandClient['tvRemote']>().toEqualTypeOf<
      (options: TvRemoteCommandOptions) => Promise<CommandResult<'tv-remote'>>
    >();
  });

  test('system command family projects Node client command methods', () => {
    expect(systemCommandFamily.clientCommandMethods).toEqual({
      appState: 'appstate',
      back: 'back',
      home: 'home',
      rotate: 'rotate',
      appSwitcher: 'app-switcher',
      keyboard: 'keyboard',
      clipboard: 'clipboard',
      tvRemote: 'tv-remote',
    });
  });

  test('navigation executable contracts own their MCP output schemas', () => {
    expect(
      Object.fromEntries(
        systemCommandFamily.definitions.flatMap((definition) =>
          'projection' in definition ? [[definition.name, definition.projection.clientMethod]] : [],
        ),
      ),
    ).toEqual({
      back: 'back',
      home: 'home',
      rotate: 'rotate',
      'app-switcher': 'appSwitcher',
      'tv-remote': 'tvRemote',
    });
  });

  test('parameterless readers project common selection flags through', () => {
    for (const reader of [appStateCliReader, homeCliReader, appSwitcherCliReader]) {
      expect(reader([], flags({ platform: 'ios' }))).toEqual({
        platform: 'ios',
      });
    }
  });

  test('parameterless daemon writers emit command names with no positionals', () => {
    expect(appStateDaemonWriter({})).toMatchObject({ command: 'appstate', positionals: [] });
    expect(homeDaemonWriter({})).toMatchObject({ command: 'home', positionals: [] });
    expect(appSwitcherDaemonWriter({})).toMatchObject({
      command: 'app-switcher',
      positionals: [],
    });
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

  test('rotate reader and writer normalize orientation', () => {
    expect(rotateCliReader(['left'], flags())).toMatchObject({
      orientation: 'landscape-left',
    });
    expect(rotateDaemonWriter({ orientation: 'portrait' }).positionals).toEqual(['portrait']);
  });

  test('rotate reader and writer reject missing orientation', () => {
    expectInvalidArgs(() => rotateCliReader([], flags()), 'rotate requires an orientation');
    expectInvalidArgs(() => rotateDaemonWriter({}), 'rotate requires orientation');
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
});
