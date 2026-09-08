import { test } from 'vitest';
import assert from 'node:assert/strict';
import { commandDescriptors } from '../registry.ts';
import { resolvePlannedRuntimeOperations } from '../planned-operations.ts';

const steps = (...commands: string[]) =>
  commands.map((command) => ({ command, positionals: [], flags: {} }));

test('observation commands require only capture and selector-observation operations', () => {
  const operations = resolvePlannedRuntimeOperations(steps('snapshot', 'wait', 'is', 'screenshot'));
  assert.ok(operations);
  assert.ok(operations.includes('captureSnapshot'));
  assert.ok(!operations.includes('captureSnapshotWithCustomActions'));
  for (const operation of operations) {
    assert.doesNotMatch(operation, /^(tap|fill|type|scroll|perform|hover|focus|longPress)/);
  }
});

test('a preferred native read is a fast path, never a plan requirement', () => {
  // `get` prefers the runner's point read but succeeds from the capture; the plan must not pull
  // a runner in for it (ADR 0019: preferred is an optimization, required is the requirement).
  const operations = resolvePlannedRuntimeOperations(steps('get'));
  assert.ok(operations);
  assert.ok(!operations.includes('readTextAtPoint'));
  assert.ok(operations.includes('captureSnapshot'));
});

test('a snapshot step requires the custom-actions capture only when the daemon flag asks', () => {
  const plain = resolvePlannedRuntimeOperations([
    { command: 'snapshot', positionals: [], flags: { depth: 2 } },
  ]);
  const custom = resolvePlannedRuntimeOperations([
    { command: 'snapshot', positionals: [], flags: { snapshotCustomActions: true } },
  ]);
  assert.ok(plain && custom);
  assert.ok(!plain.includes('captureSnapshotWithCustomActions'));
  assert.ok(custom.includes('captureSnapshotWithCustomActions'));
});

test('a find step is planned from its positionals the way the handler parses them', () => {
  const find = (...positionals: string[]) =>
    resolvePlannedRuntimeOperations([{ command: 'find', positionals, flags: {} }]);
  const readOnly = find('text="Settings"', 'exists');
  const text = find('text="Settings"', 'get', 'text');
  const typed = find('text="Email"', 'type', 'hello');
  const defaultClick = find('text="Settings"');
  const unparsed = resolvePlannedRuntimeOperations([{ command: 'find', flags: {} }]);
  assert.ok(readOnly && text && typed && defaultClick && unparsed);
  assert.deepEqual(readOnly, ['captureSnapshot', 'captureSnapshotWithoutActiveApp']);
  assert.deepEqual(text, ['captureSnapshot', 'captureSnapshotWithoutActiveApp']);
  assert.ok(typed.includes('typeText') && typed.includes('focusPoint'));
  // A missing action is a click, and a step that cannot be parsed keeps every alternative.
  assert.ok(defaultClick.includes('focusPoint') && defaultClick.includes('typeText'));
  assert.deepEqual(unparsed, defaultClick);
});

test('an interaction command contributes its required touch operations', () => {
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
  const probes = [
    { positionals: [], flags: {} },
    { positionals: [], flags: { snapshotCustomActions: true } },
    { positionals: ['text="x"', 'get', 'text'], flags: {} },
    { positionals: ['text="x"', 'type', 'y'], flags: {} },
    { positionals: ['text="x"'], flags: {} },
    { flags: {} },
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
