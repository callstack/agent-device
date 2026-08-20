import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';

const SIMPLE_PUBLISHERS = [
  new URL('../../daemon/device-claims.ts', import.meta.url),
  new URL('../../daemon/daemon-shutdown-report.ts', import.meta.url),
  new URL('../../daemon/provider-lease-expiry.ts', import.meta.url),
  new URL('../../daemon/session-script-writer.ts', import.meta.url),
  new URL('../../platforms/apple/core/runner/runner-lease.ts', import.meta.url),
  new URL('../../remote/remote-connection-state.ts', import.meta.url),
  new URL('../process-lock.ts', import.meta.url),
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
    new URL('../../daemon/durable-capture-resource-store.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /withAtomicPublishTempPathSync/);
  assert.match(source, /fs\.openSync\([^\n]+['"]wx['"]/);
  assert.match(source, /fs\.fsyncSync/);
  assert.match(source, /fs\.renameSync/);
  assert.match(source, /assertSafeDestination/);
});
