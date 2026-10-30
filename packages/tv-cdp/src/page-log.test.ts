import assert from 'node:assert/strict';
import { test } from 'vitest';

import { createPageLog } from './page-log.ts';

const fixedClock = () => new Date('2026-10-30T12:00:00.000Z');

test('console calls become timestamped lines with their arguments', () => {
  const log = createPageLog(fixedClock);

  log.record('Runtime.consoleAPICalled', {
    type: 'warn',
    args: [
      { type: 'string', value: 'slow tab' },
      { type: 'number', value: 42 },
    ],
  });

  assert.equal(log.tail(10), '2026-10-30T12:00:00.000Z console.warn slow tab 42\n');
});

test('objects logged from the page show their previewed properties', () => {
  const log = createPageLog(fixedClock);

  log.record('Runtime.consoleAPICalled', {
    type: 'log',
    args: [
      { type: 'string', value: '[Analytics]' },
      {
        type: 'object',
        description: 'Object',
        preview: {
          overflow: true,
          properties: [
            { name: 'event', type: 'string', value: 'tab_view' },
            { name: 'index', type: 'number', value: '2' },
          ],
        },
      },
    ],
  });

  assert.equal(
    log.tail(1),
    '2026-10-30T12:00:00.000Z console.log [Analytics] {event: "tab_view", index: 2, …}\n',
  );
});

test('the buffer keeps only the most recent lines', () => {
  const log = createPageLog(fixedClock);

  for (let index = 0; index < 5005; index += 1) {
    log.record('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ type: 'string', value: `line ${index}` }],
    });
  }

  const lines = log.tail(10_000).trimEnd().split('\n');
  assert.equal(lines.length, 5000);
  assert.match(lines[0]!, /line 5$/);
});
