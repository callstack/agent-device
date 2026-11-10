import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseArgs } from '../args.ts';

test('parseArgs accepts install-from-source url and repeated headers', () => {
  const parsed = parseArgs(
    [
      'install-from-source',
      'https://example.com/builds/app.apk',
      '--header',
      'authorization: Bearer token',
      '--header',
      'x-build-id: 42',
      '--retain-paths',
      '--retention-ms',
      '60000',
    ],
    { strictFlags: true },
  );
  assert.equal(parsed.command, 'install-from-source');
  assert.deepEqual(parsed.positionals, ['https://example.com/builds/app.apk']);
  assert.deepEqual(parsed.flags.header, ['authorization: Bearer token', 'x-build-id: 42']);
  assert.equal(parsed.flags.retainPaths, true);
  assert.equal(parsed.flags.retentionMs, 60000);
});

test('parseArgs bounds retention milliseconds', () => {
  const args = ['install-from-source', './app.apk', '--retention-ms'];
  assert.equal(
    parseArgs([...args, '2147483647'], { strictFlags: true }).flags.retentionMs,
    2147483647,
  );
  for (const value of ['0', '2147483648']) {
    assert.throws(() => parseArgs([...args, value], { strictFlags: true }), {
      code: 'INVALID_ARGS',
    });
  }
});
