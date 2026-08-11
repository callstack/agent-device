import { describe, expect, test } from 'vitest';
import type { CliFlags } from '@agent-device/contracts/command';
import {
  perfCliReader,
  perfCommandDefinition,
  perfCommandMetadata,
  perfDaemonWriter,
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

describe('perf command interface', () => {
  test('owns perf public metadata', () => {
    expect(perfCommandMetadata.name).toBe('perf');
    expect(perfCommandDefinition.name).toBe('perf');
  });

  test('reads perf area, action, kind, and out flags', () => {
    expect(
      perfCliReader(['memory', 'snapshot'], {
        kind: 'android-hprof',
        out: './heap.hprof',
      } as CliFlags),
    ).toEqual({
      area: 'memory',
      action: 'snapshot',
      kind: 'android-hprof',
      out: './heap.hprof',
    });
  });

  test('retains optional aggregate compatibility and writes focused areas', () => {
    expect(perfCliReader([], NO_FLAGS)).toEqual({});
    expect(perfDaemonWriter({ area: 'frames' })).toMatchObject({
      command: 'perf',
      positionals: ['frames'],
    });
  });

  test('rejects invalid perf positionals', () => {
    expectInvalidArgs(() => perfCliReader(['memory', 'explode'], NO_FLAGS), 'perf action');
  });
});
