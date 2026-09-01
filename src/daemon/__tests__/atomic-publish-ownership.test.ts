import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';

const SIMPLE_PUBLISHERS = [
  new URL('../device-claims.ts', import.meta.url),
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

test('durable capture publication keeps its specialized fsync and destination checks', () => {
  const source = fs.readFileSync(
    new URL('../durable-capture-resource-store.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /withAtomicPublishTempPathSync/);
  assert.match(source, /fs\.openSync\([^\n]+['"]wx['"]/);
  assert.match(source, /fs\.fsyncSync/);
  assert.match(source, /fs\.renameSync/);
  assert.match(source, /assertSafeDestination/);
});
