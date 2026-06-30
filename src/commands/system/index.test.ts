import { describe, expect, test } from 'vitest';
import type { CliFlags } from '../../cli/parser/cli-flags.ts';
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
});
