import { test } from 'vitest';
import assert from 'node:assert/strict';
import { commandDescriptors } from '../registry.ts';
import { resolvePlannedRuntimeOperations } from '../planned-operations.ts';

const steps = (...commands: string[]) => commands.map((command) => ({ command }));

test('observation commands declare only capture and selector-observation operations', () => {
  const operations = resolvePlannedRuntimeOperations(steps('snapshot', 'wait', 'is', 'screenshot'));
  assert.ok(operations);
  assert.ok(operations.includes('captureSnapshot'));
  assert.ok(operations.includes('findText'));
  assert.ok(!operations.includes('captureSnapshotWithCustomActions'));
  for (const operation of operations) {
    assert.doesNotMatch(operation, /^(tap|fill|type|scroll|perform|hover|focus|longPress)/);
  }
});

test('a snapshot step selects the custom-actions alternative only when its input asks for it', () => {
  const plain = resolvePlannedRuntimeOperations([{ command: 'snapshot', input: { depth: 2 } }]);
  const custom = resolvePlannedRuntimeOperations([
    { command: 'snapshot', input: { customActions: true } },
  ]);
  assert.ok(plain && custom);
  assert.ok(!plain.includes('captureSnapshotWithCustomActions'));
  assert.ok(custom.includes('captureSnapshotWithCustomActions'));
});

test('a find step selects its leg from the action', () => {
  const readOnly = resolvePlannedRuntimeOperations([{ command: 'find' }]);
  const text = resolvePlannedRuntimeOperations([{ command: 'find', input: { action: 'getText' } }]);
  const typed = resolvePlannedRuntimeOperations([{ command: 'find', input: { action: 'type' } }]);
  const clicked = resolvePlannedRuntimeOperations([
    { command: 'find', input: { action: 'click' } },
  ]);
  assert.ok(readOnly && text && typed && clicked);
  assert.deepEqual(
    readOnly.filter((operation) => /readTextAtPoint|focusPoint|typeText/.test(operation)),
    [],
  );
  assert.ok(text.includes('readTextAtPoint'));
  assert.ok(typed.includes('typeText'));
  // A delegated leg keeps every declared alternative rather than guessing.
  assert.ok(clicked.includes('readTextAtPoint') && clicked.includes('typeText'));
});

test('an interaction command contributes its touch operations', () => {
  const operations = resolvePlannedRuntimeOperations(steps('snapshot', 'click'));
  assert.ok(operations);
  assert.ok(operations.some((operation) => /^tap/.test(operation)));
});

test('commands without device runtime execution contribute nothing', () => {
  assert.deepEqual(resolvePlannedRuntimeOperations(steps('devices', 'capabilities')), []);
});

test('an unregistered command makes the plan unproven', () => {
  assert.equal(resolvePlannedRuntimeOperations(steps('snapshot', 'not-a-command')), undefined);
});

test('every step selector returns a non-empty subset of the alternatives its command declares', () => {
  const probes: Array<Record<string, unknown> | undefined> = [
    undefined,
    { customActions: true },
    { action: 'getText' },
    { action: 'type' },
    { action: 'click' },
  ];
  let selectors = 0;
  for (const descriptor of commandDescriptors) {
    const execution = descriptor.platformExecution;
    if (execution.kind !== 'device-runtime' || !('uses' in execution) || !execution.selectUses) {
      continue;
    }
    selectors += 1;
    for (const probe of probes) {
      const selected = execution.selectUses(probe);
      assert.ok(selected.length > 0, `${descriptor.name} selected no use`);
      for (const use of selected) {
        assert.ok(execution.uses.includes(use), `${descriptor.name} selected an undeclared use`);
      }
    }
  }
  // The commands whose declared alternatives differ in what they execute on a device.
  assert.equal(selectors, 3);
});
