import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'vitest';
import { MAXIMUM_REQUEST_LEVELS, resolveSnapshotSourceLimits } from './limits.ts';
import type { SnapshotSourceLimits } from './types.ts';

// The host and the native bridge share these bounds only through source, so this guard reads
// each native literal and fails if either side drifts.
const nativeSource = (
  await Promise.all(
    ['SnapshotBridgeRuntime.m', 'SnapshotBridgeCapture.m'].map((fileName) =>
      readFile(
        path.join(import.meta.dirname, '../../../../apple/snapshot-bridge', fileName),
        'utf8',
      ),
    ),
  )
).join('\n');

function nativeConstant(name: string): number {
  const match = new RegExp(
    `^const (?:NSUInteger|uint32_t) ${name} = (\\d+(?: \\* \\d+)*);$`,
    'm',
  ).exec(nativeSource);
  const value = match?.[1];
  assert.ok(value, `the native bridge no longer declares ${name}`);
  return value.split(' * ').reduce((product, factor) => product * Number(factor), 1);
}

test('the first-request window matches the native bridge', () => {
  assert.equal(MAXIMUM_REQUEST_LEVELS, nativeConstant('kMaximumRequestLevels'));
});

test.each([
  ['maxResponseBytes', 'kMaximumFrameBytes'],
  ['maxTraversalDepth', 'kMaximumDepth'],
  ['maxNodes', 'kMaximumNodes'],
  ['maxDurationMs', 'kMaximumDurationMs'],
] as const)('%s accepts the native %s and rejects one more', (limit, native) => {
  const bound = nativeConstant(native);
  const resolve = (value: number) =>
    resolveSnapshotSourceLimits({ [limit]: value } satisfies Partial<SnapshotSourceLimits>);
  assert.equal(resolve(bound)[limit], bound);
  assert.throws(() => resolve(bound + 1), { code: 'INVALID_ARGS' });
});
