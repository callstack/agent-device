import { describe, expect, test } from 'vitest';
import type { CliFlags } from '@agent-device/contracts/command';
import {
  audioCliReader,
  audioCommandFacet,
  audioCommandMetadata,
  audioDaemonWriter,
  eventsCliReader,
  eventsCommandFacet,
  eventsCommandMetadata,
  eventsDaemonWriter,
  logsCliReader,
  logsCommandFacet,
  logsCommandMetadata,
  logsDaemonWriter,
  networkCliReader,
  networkCommandFacet,
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
    expect(audioCommandMetadata.name).toBe('audio');
    expect(audioCommandFacet.definition.name).toBe('audio');
    expect(eventsCommandMetadata.name).toBe('events');
    expect(eventsCommandFacet.definition.name).toBe('events');
    expect(logsCommandMetadata.name).toBe('logs');
    expect(logsCommandFacet.definition.name).toBe('logs');
    expect(networkCommandMetadata.name).toBe('network');
    expect(networkCommandFacet.definition.name).toBe('network');
  });

  test('reads audio probe timing as compact daemon positionals', () => {
    expect(audioCliReader(['probe', 'start', '7.5', '500'], NO_FLAGS)).toEqual({
      action: 'probe',
      probeAction: 'start',
      durationMs: 7500,
      bucketMs: 500,
    });
    expect(
      audioDaemonWriter({
        action: 'probe',
        probeAction: 'start',
        durationMs: 7500,
        bucketMs: 500,
      }),
    ).toMatchObject({
      command: 'audio',
      positionals: ['probe', 'start', '7500', '500'],
    });
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

  test('reads events pagination as compact daemon positionals', () => {
    expect(eventsCliReader(['25', '100'], NO_FLAGS)).toEqual({
      limit: 25,
      cursor: '100',
    });
    expect(eventsCliReader(['', '100'], NO_FLAGS)).toEqual({
      limit: undefined,
      cursor: '100',
    });
    expect(eventsDaemonWriter({ limit: 25, cursor: '100' })).toMatchObject({
      command: 'events',
      positionals: ['25', '100'],
    });
    expect(eventsDaemonWriter({ cursor: '100' })).toMatchObject({
      command: 'events',
      positionals: ['', '100'],
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
    expectInvalidArgs(() => audioCliReader(['explode'], NO_FLAGS), 'audio requires probe');
    expectInvalidArgs(() => audioCliReader(['probe', 'explode'], NO_FLAGS), 'audio probe requires');
    expectInvalidArgs(
      () => networkCliReader(['dump', '25', 'explode'], NO_FLAGS),
      'network include',
    );
  });
});
