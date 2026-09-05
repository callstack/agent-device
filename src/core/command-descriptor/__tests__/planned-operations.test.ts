import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resolvePlannedRuntimeOperations } from '../planned-operations.ts';

test('observation commands declare only capture and selector-observation operations', () => {
  const operations = resolvePlannedRuntimeOperations(['snapshot', 'wait', 'is', 'screenshot']);
  assert.ok(operations);
  assert.ok(operations.includes('captureSnapshot'));
  assert.ok(operations.includes('findText'));
  for (const operation of operations) {
    assert.doesNotMatch(operation, /^(tap|fill|type|scroll|perform|hover|focus|longPress)/);
  }
});

test('an interaction command contributes its touch operations', () => {
  const operations = resolvePlannedRuntimeOperations(['snapshot', 'click']);
  assert.ok(operations);
  assert.ok(operations.some((operation) => /^tap/.test(operation)));
});

test('every declared use category counts, so a mutating find is never proven observation-only', () => {
  const operations = resolvePlannedRuntimeOperations(['find']);
  assert.ok(operations);
  assert.ok(operations.some((operation) => /^tap|^fill|^type/.test(operation)));
});

test('commands without device runtime execution contribute nothing', () => {
  assert.deepEqual(resolvePlannedRuntimeOperations(['devices', 'capabilities']), []);
});

test('an unregistered command makes the plan unproven', () => {
  assert.equal(resolvePlannedRuntimeOperations(['snapshot', 'not-a-command']), undefined);
});
