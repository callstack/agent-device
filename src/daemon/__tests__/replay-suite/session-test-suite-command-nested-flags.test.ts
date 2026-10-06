/**
 * `buildNestedReplayFlags` — how one suite attempt's flags are projected from the parent `test`
 * request. Moved here with the function itself when the test-suite command left
 * the replay command handler; tests mirror source topology (AGENTS.md).
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildNestedReplayFlags } from '@agent-device/replay-port/test-command';

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

// #2997: the suite command's own --test-ime opt-in must fan out to every attempt's
// nested replay, or a real-device suite cannot opt in to the test IME its eraseText
// steps need. Parent flags ride through untouched, so pin that here.
test('buildNestedReplayFlags fans the parent testIme opt-in onto every attempt', () => {
  const result = buildNestedReplayFlags({
    parentFlags: { platform: 'android', testIme: true },
    platform: undefined,
    target: undefined,
    artifactsDir: '/suite-root/flow/attempt-1',
  });
  assert.equal(result?.testIme, true);

  const optedOut = buildNestedReplayFlags({
    parentFlags: { platform: 'android', testIme: false },
    platform: undefined,
    target: undefined,
    artifactsDir: '/suite-root/flow/attempt-1',
  });
  assert.equal(optedOut?.testIme, false);
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
