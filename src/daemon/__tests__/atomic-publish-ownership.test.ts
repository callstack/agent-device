import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';

const SIMPLE_PUBLISHERS = [
  // device-claims.ts delegates every write to device-claim-store.ts's writeDeviceClaim, the
  // single writer shared by the process-owned and allocator-held claim kinds.
  new URL('../device-claim-store.ts', import.meta.url),
  new URL('../daemon-shutdown-report.ts', import.meta.url),
  new URL('../provider-lease-expiry.ts', import.meta.url),
  new URL('../session-script-writer.ts', import.meta.url),
  new URL('../../../packages/platform-apple/src/runner/runner-lease.ts', import.meta.url),
  new URL('../../remote/remote-connection-state.ts', import.meta.url),
] as const;

const PROCESS_LOCK_SOURCE = new URL(
  '../../../packages/host-kit/src/internal/process-lock.ts',
  import.meta.url,
);

test('simple same-directory publishers use the shared atomic publish owner', () => {
  for (const sourcePath of SIMPLE_PUBLISHERS) {
    const source = fs.readFileSync(sourcePath, 'utf8');
    assert.match(source, /publishFileSync/);
    assert.doesNotMatch(source, /fs\.(?:writeFileSync|renameSync)\s*\(/);
  }
});

// The process lock publishes a file and reclaims a directory, which are two different
// claims of ownership: only the first belongs to the publication owners above.
test('the process lock publishes its owner record without publishing files by hand', () => {
  const source = fs.readFileSync(PROCESS_LOCK_SOURCE, 'utf8');
  assert.match(source, /publishFileSync/);
  assert.doesNotMatch(source, /fs\.writeFileSync\s*\(/);
});

// A reclaim that parked the judged directory under another name put the lock path in the state
// a polling contender reads as free, so nothing here may rename it. What it does instead is
// empty and remove the path, which cannot address anything but the directory judged stale.
test('the process lock reclaims in place instead of renaming the lock path', () => {
  const source = fs.readFileSync(PROCESS_LOCK_SOURCE, 'utf8');
  assert.doesNotMatch(source, /renameSync|asidePath|\.reclaimed-/);
  assert.match(source, /fs\.rmdirSync/);
});

test('durable publishers share the host-kit durable publication owner', () => {
  const sourcePaths = [
    new URL('../../../packages/capture-kit/src/durable-capture/store.ts', import.meta.url),
    new URL('../../../packages/managed-allocation/src/store-filesystem.ts', import.meta.url),
  ];
  for (const sourcePath of sourcePaths) {
    const source = fs.readFileSync(sourcePath, 'utf8');
    assert.match(source, /publishDurableFileSync/);
    assert.doesNotMatch(
      source,
      /fs\.(?:openSync|writeFileSync|fsyncSync|renameSync|linkSync)\s*\(/,
    );
    assert.doesNotMatch(source, /assertSafeDestination/);
  }
});
