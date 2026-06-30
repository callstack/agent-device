import { describe, expect, test } from 'vitest';
import type { CliFlags } from '../../cli/parser/cli-flags.ts';
import {
  logsCliReader,
  logsCommandDefinition,
  logsCommandMetadata,
  logsDaemonWriter,
  networkCliReader,
  networkCommandDefinition,
  networkCommandMetadata,
  networkDaemonWriter,
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

describe('observability command interface', () => {
  test('owns logs and network public metadata', () => {
    expect(logsCommandMetadata.name).toBe('logs');
    expect(logsCommandDefinition.name).toBe('logs');
    expect(networkCommandMetadata.name).toBe('network');
    expect(networkCommandDefinition.name).toBe('network');
  });

  test('reads logs action and message', () => {
    expect(logsCliReader(['mark', 'checkout', 'started'], NO_FLAGS)).toEqual({
      action: 'mark',
      message: 'checkout started',
      restart: undefined,
    });
    expect(logsDaemonWriter({ action: 'mark', message: 'checkout started' })).toMatchObject({
      command: 'logs',
      positionals: ['mark', 'checkout started'],
    });
  });

  test('reads network include from flag or positional', () => {
    expect(networkCliReader(['dump', '25', 'headers'], NO_FLAGS)).toEqual({
      action: 'dump',
      limit: 25,
      include: 'headers',
    });
    expect(
      networkCliReader(['dump', '25', 'headers'], { networkInclude: 'all' } as CliFlags),
    ).toMatchObject({
      include: 'all',
    });
  });

  test('writes network include as daemon flag', () => {
    expect(networkDaemonWriter({ action: 'dump', limit: 25, include: 'body' })).toMatchObject({
      command: 'network',
      positionals: ['dump', '25'],
      options: { networkInclude: 'body' },
    });
  });

  test('rejects invalid observability positionals', () => {
    expectInvalidArgs(() => logsCliReader(['explode'], NO_FLAGS), 'logs requires');
    expectInvalidArgs(() => networkCliReader(['explode'], NO_FLAGS), 'network requires');
    expectInvalidArgs(
      () => networkCliReader(['dump', '25', 'explode'], NO_FLAGS),
      'network include',
    );
  });
});
