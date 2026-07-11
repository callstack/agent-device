import { describe, expect, test } from 'vitest';
import type { CliFlags } from '../cli-grammar/flag-types.ts';
import { debugCliReader, debugCommandDefinition, debugCommandMetadata } from './index.ts';

describe('debugging command interface', () => {
  test('owns debug public metadata', () => {
    expect(debugCommandMetadata.name).toBe('debug');
    expect(debugCommandDefinition.name).toBe('debug');
  });

  test('reads debug symbols crash artifact inputs', () => {
    expect(
      debugCliReader(['symbols'], {
        artifact: 'crash.ips',
        dsym: 'Demo.app.dSYM',
        out: 'crash-symbolicated.ips',
      } as CliFlags),
    ).toEqual({
      action: 'symbols',
      artifact: 'crash.ips',
      dsym: 'Demo.app.dSYM',
      searchPath: undefined,
      out: 'crash-symbolicated.ips',
    });
  });

  test('rejects unsupported debug actions', () => {
    expect(() => debugCliReader(['live'], {} as CliFlags)).toThrow(
      expect.objectContaining({
        code: 'INVALID_ARGS',
        message: expect.stringContaining('debug supports only symbols'),
      }),
    );
  });
});
