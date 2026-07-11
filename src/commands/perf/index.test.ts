import { describe, expect, test } from 'vitest';
import type { CliFlags } from '../cli-grammar/flag-types.ts';
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

  test('treats a single perf action as metrics action', () => {
    expect(perfCliReader(['sample'], NO_FLAGS)).toEqual({
      action: 'sample',
      kind: undefined,
      out: undefined,
    });
    expect(perfDaemonWriter({ action: 'sample' })).toMatchObject({
      command: 'perf',
      positionals: ['metrics', 'sample'],
    });
  });

  test('rejects invalid perf positionals', () => {
    expectInvalidArgs(() => perfCliReader(['memory', 'explode'], NO_FLAGS), 'perf action');
  });
});
