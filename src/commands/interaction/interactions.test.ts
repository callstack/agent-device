import { expect, test } from 'vitest';
import { interactionDaemonWriters } from './interactions.ts';

test('swipe writes only typed daemon input', () => {
  const request = interactionDaemonWriters.swipe({
    from: { x: 10, y: 20 },
    to: { x: 30, y: 40 },
    durationMs: 300,
    count: 2,
    pauseMs: 10,
    pattern: 'ping-pong',
  });

  expect(request.positionals).toEqual([]);
  expect(request.input).toEqual({
    from: { x: 10, y: 20 },
    to: { x: 30, y: 40 },
    durationMs: 300,
    count: 2,
    pauseMs: 10,
    pattern: 'ping-pong',
  });
});
