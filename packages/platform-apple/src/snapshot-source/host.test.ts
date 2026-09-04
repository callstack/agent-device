import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createSnapshotSourceHost, snapshotSourceSocketPath } from './host.ts';

test('snapshot bridge socket paths stay within the AF_UNIX limit and are target-specific', () => {
  const host = createSnapshotSourceHost();
  const first = snapshotSourceSocketPath(host, 'simulator-1', 'owner-1');
  const second = snapshotSourceSocketPath(host, 'simulator-2', 'owner-1');
  const otherOwner = snapshotSourceSocketPath(host, 'simulator-1', 'owner-2');

  assert.equal(first.length < 104, true);
  assert.equal(second.length < 104, true);
  assert.equal(otherOwner.length < 104, true);
  assert.notEqual(first, second);
  assert.notEqual(first, otherOwner);
});
