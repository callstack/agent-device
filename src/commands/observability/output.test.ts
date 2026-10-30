import { describe, expect, test } from 'vitest';
import { observabilityCliOutputFormatters } from './output.ts';

describe('observability CLI output', () => {
  test('formats events as a compact human timeline', () => {
    const output = observabilityCliOutputFormatters.events({
      env: process.env,
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
      env: process.env,
      input: {},
      result: { path: '/tmp/session/events.ndjson', cursor: '0', limit: 100, events: [] },
    });

    expect(output.text).toBe('No session events found.');
    expect(output.stderr).toContain('cursor=0');
  });
});
