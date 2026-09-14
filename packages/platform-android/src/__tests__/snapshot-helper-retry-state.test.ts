import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isAndroidSnapshotHelperRetryStateStanding } from '../snapshot-helper-retry-state.ts';

const NOW_MS = 10_000_000;

test('a state with no retry time stands until something settles it', () => {
  assert.equal(isAndroidSnapshotHelperRetryStateStanding({ value: 'x' }, NOW_MS), true);
});

test('a state with a retry time stands only until that time', () => {
  const state = { value: 'x', retryAtMs: NOW_MS + 60_000 };
  assert.equal(isAndroidSnapshotHelperRetryStateStanding(state, NOW_MS), true);
  assert.equal(isAndroidSnapshotHelperRetryStateStanding(state, NOW_MS + 60_000), false);
});
