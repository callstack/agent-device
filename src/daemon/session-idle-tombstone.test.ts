import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  readIdleSessionTombstoneFile,
  resolveIdleSessionTombstonePath,
} from './session-idle-tombstone.ts';
import { mkdtempForTestSync } from '../__tests__/test-utils/tmp-dir.ts';

test('a marker whose lifetime cannot be represented stops explaining the absence', () => {
  const markerPath = resolveIdleSessionTombstonePath(
    mkdtempForTestSync('agent-device-idle-tombstone-range-'),
  );

  // `JSON.parse` turns this literal into `Infinity`, which is greater than every clock reading. A
  // reader that only asks "is it a number, and still ahead?" accepts it, and one damaged file then
  // owns this session key forever.
  fs.writeFileSync(
    markerPath,
    '{"owner":"default","expiredAtMs":1,"expiresAt":1e400,"idleExpiryMs":1000}\n',
  );
  assert.equal(readIdleSessionTombstoneFile(markerPath), undefined);

  fs.writeFileSync(
    markerPath,
    '{"owner":"default","expiredAtMs":1,"expiresAt":9e15,"idleExpiryMs":1e400}\n',
  );
  assert.equal(readIdleSessionTombstoneFile(markerPath), undefined);

  // The device key is quoted back to the agent as the device to re-claim, so a value the writer could
  // not have produced must not travel into that sentence.
  fs.writeFileSync(
    markerPath,
    '{"owner":"default","expiredAtMs":1,"expiresAt":9e15,"idleExpiryMs":1000,"deviceKey":7}\n',
  );
  assert.equal(readIdleSessionTombstoneFile(markerPath), undefined);
});
