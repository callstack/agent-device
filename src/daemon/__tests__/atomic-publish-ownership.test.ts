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
  new URL('../../../packages/host-kit/src/internal/process-lock.ts', import.meta.url),
] as const;

test('simple same-directory publishers use the shared atomic publish owner', () => {
  for (const sourcePath of SIMPLE_PUBLISHERS) {
    const source = fs.readFileSync(sourcePath, 'utf8');
    assert.match(source, /publishFileSync/);
    assert.doesNotMatch(source, /fs\.(?:writeFileSync|renameSync)\s*\(/);
  }
});

test('durable publishers share the host-kit durable publication owner', () => {
  const sourcePaths = [
    new URL('../durable-capture-resource-store.ts', import.meta.url),
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
