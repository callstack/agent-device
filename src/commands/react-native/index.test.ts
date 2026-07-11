import { describe, expect, test } from 'vitest';
import type { CliFlags } from '../cli-grammar/flag-types.ts';
import {
  reactNativeCliReader,
  reactNativeCommandDefinition,
  reactNativeCommandMetadata,
  reactNativeDaemonWriter,
} from './index.ts';

const NO_FLAGS = {} as CliFlags;

function expectInvalidArgs(fn: () => unknown, messageFragment: string) {
  expect(fn).toThrow(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      message: expect.stringContaining(messageFragment),
    }),
  );
}

describe('react-native command interface', () => {
  test('owns its public metadata', () => {
    expect(reactNativeCommandMetadata.name).toBe('react-native');
    expect(reactNativeCommandDefinition.name).toBe('react-native');
    expect(reactNativeCommandMetadata.description).toContain('React Native');
  });

  test('reads the dismiss-overlay CLI action', () => {
    expect(reactNativeCliReader(['dismiss-overlay'], NO_FLAGS)).toEqual({
      action: 'dismiss-overlay',
    });
  });

  test('rejects unsupported CLI actions', () => {
    expectInvalidArgs(
      () => reactNativeCliReader(['reload'], NO_FLAGS),
      'react-native supports only',
    );
  });

  test('writes daemon request positionals', () => {
    expect(reactNativeDaemonWriter({ action: 'dismiss-overlay' })).toMatchObject({
      command: 'react-native',
      positionals: ['dismiss-overlay'],
      options: { action: 'dismiss-overlay' },
    });
  });

  test('rejects daemon request without action', () => {
    expectInvalidArgs(() => reactNativeDaemonWriter({}), 'react-native requires action');
  });
});
