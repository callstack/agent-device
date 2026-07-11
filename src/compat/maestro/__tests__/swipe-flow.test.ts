import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseMaestroReplayFlow } from '../replay-flow.ts';

test('coordinate endpoints take precedence over from like Maestro', () => {
  const parsed = parseMaestroReplayFlow(`appId: com.pagerviewexample
---
- swipe:
    from:
      id: pager-view
    start: 90%, 50%
    end: 10%, 50%
    duration: 100
`);

  assert.deepEqual(
    parsed.actions.map((entry) => [entry.command, entry.positionals]),
    [['__maestroSwipeScreen', ['percent', '90', '50', '10', '50', '100']]],
  );
});

test('coordinate swipes require both endpoints even when from is present', () => {
  assert.throws(
    () =>
      parseMaestroReplayFlow(`---
- swipe:
    from:
      id: pager-view
    start: 90%, 50%
`),
    /both start and end coordinates/i,
  );
});

test('coordinate swipes reject direction like Maestro', () => {
  assert.throws(
    () =>
      parseMaestroReplayFlow(`---
- swipe:
    direction: LEFT
    start: 90%, 50%
    end: 10%, 50%
`),
    /cannot combine direction with start\/end coordinates/i,
  );
});
