import { describe, expect, test } from 'vitest';
import type { CliFlags } from '../cli-grammar/flag-types.ts';
import {
  audioCliReader,
  audioCommandDefinition,
  audioCommandMetadata,
  audioDaemonWriter,
  eventsCliReader,
  eventsCommandDefinition,
  eventsCommandMetadata,
  eventsDaemonWriter,
  logsCliReader,
  logsCommandDefinition,
  logsCommandMetadata,
  logsDaemonWriter,
  networkCliReader,
  networkCommandDefinition,
  networkCommandMetadata,
  networkDaemonWriter,
} from './index.ts';
import { observabilityCliOutputFormatters } from './output.ts';

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
    expect(audioCommandDefinition.name).toBe('audio');
    expect(eventsCommandMetadata.name).toBe('events');
    expect(eventsCommandDefinition.name).toBe('events');
    expect(logsCommandMetadata.name).toBe('logs');
    expect(logsCommandDefinition.name).toBe('logs');
    expect(networkCommandMetadata.name).toBe('network');
    expect(networkCommandDefinition.name).toBe('network');
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

  test('formats events as a compact human timeline', () => {
    const output = observabilityCliOutputFormatters.events({
      input: {},
      result: {
        path: '/tmp/session/events.ndjson',
        cursor: '0',
        limit: 100,
        events: [
          {
            version: 1,
            ts: '2026-07-02T12:00:00.000Z',
            session: 'default',
            kind: 'request.started',
            command: 'open',
            summary: 'Started open',
          },
          {
            version: 1,
            ts: '2026-07-02T12:00:00.250Z',
            session: 'default',
            kind: 'request.finished',
            command: 'open',
            status: 'ok',
            summary: 'Finished open',
            details: { durationMs: 250 },
          },
          {
            version: 1,
            ts: '2026-07-02T12:00:01.000Z',
            session: 'default',
            kind: 'action.recorded',
            command: 'fill',
            summary: 'Filled @e14',
            details: { ref: '@e14', textLength: 8 },
          },
        ],
      },
    });

    expect(output.text).toContain('2026-07-02 12:00:00.000Z  start open');
    expect(output.text).toContain('2026-07-02 12:00:00.250Z  ok open 250ms');
    expect(output.text).toContain('2026-07-02 12:00:01.000Z  action fill');
    expect(output.text).toContain('Filled @e14 (text=8 chars)');
    expect(output.stderr).toContain('path=/tmp/session/events.ndjson');
  });

  test('formats empty events page with a readable message', () => {
    const output = observabilityCliOutputFormatters.events({
      input: {},
      result: { path: '/tmp/session/events.ndjson', cursor: '0', limit: 100, events: [] },
    });

    expect(output.text).toBe('No session events found.');
    expect(output.stderr).toContain('cursor=0');
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
