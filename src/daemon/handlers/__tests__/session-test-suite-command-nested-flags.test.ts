/**
 * `buildNestedReplayFlags` — how one suite attempt's flags are projected from the parent `test`
 * request. Moved here with the function itself when the test-suite command left
 * `session-replay.ts`; tests mirror source topology (AGENTS.md).
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildNestedReplayFlags } from '../session-test-suite-command.ts';

test('buildNestedReplayFlags returns parent flags untouched when neither override is set', () => {
  const parent = { platform: 'android' as const, timeoutMs: 5000 };
  const result = buildNestedReplayFlags({
    parentFlags: parent,
    platform: undefined,
    target: undefined,
    artifactsDir: undefined,
  });
  assert.strictEqual(result, parent);
});

test('buildNestedReplayFlags merges platform, target, and artifactsDir into parent flags', () => {
  const parent = { timeoutMs: 5000, retries: 1 };
  const result = buildNestedReplayFlags({
    parentFlags: parent,
    platform: 'ios',
    target: 'mobile',
    artifactsDir: '/tmp/attempt-1',
  });
  assert.deepEqual(result, {
    timeoutMs: 5000,
    retries: 1,
    platform: 'ios',
    target: 'mobile',
    artifactsDir: '/tmp/attempt-1',
  });
  // Parent object must not be mutated.
  assert.equal((parent as Record<string, unknown>).artifactsDir, undefined);
});

test('buildNestedReplayFlags threads artifactsDir through even when parent lacks it', () => {
  const result = buildNestedReplayFlags({
    parentFlags: undefined,
    platform: undefined,
    target: undefined,
    artifactsDir: '/tmp/attempt-1',
  });
  assert.deepEqual(result, { artifactsDir: '/tmp/attempt-1' });
});

test('buildNestedReplayFlags overrides a parent artifactsDir with the attempt-level one', () => {
  const result = buildNestedReplayFlags({
    parentFlags: { artifactsDir: '/suite-root' },
    platform: undefined,
    target: undefined,
    artifactsDir: '/suite-root/flow/attempt-2',
  });
  assert.equal(result?.artifactsDir, '/suite-root/flow/attempt-2');
});

test('buildNestedReplayFlags strips test-only recordVideo before replay actions inherit flags', () => {
  const result = buildNestedReplayFlags({
    parentFlags: { platform: 'ios', recordVideo: true },
    platform: undefined,
    target: undefined,
    artifactsDir: undefined,
  });

  assert.deepEqual(result, { platform: 'ios' });
});
