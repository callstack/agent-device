import { test } from 'vitest';
import assert from 'node:assert/strict';
import { componentKind, componentName, splitDisplayName } from './react-component.ts';

test('splitDisplayName separates DevTools wrapper names from the component', () => {
  assert.deepEqual(splitDisplayName('Memo(ForwardRef(Row))'), {
    name: 'Row',
    wrappers: ['Memo', 'ForwardRef'],
  });
  assert.deepEqual(splitDisplayName('Row'), { name: 'Row', wrappers: [] });
});

test('tree names preserve non-React wrappers', () => {
  assert.equal(componentName('Memo(Animated(Row))'), 'Animated(Row)');
  assert.equal(componentName('ForwardRef(Memo(Row))'), 'Row');
});

for (const type of ['toString', 'constructor', '__proto__']) {
  test(`inherited key ${type} is not a component kind`, () => {
    assert.equal(componentKind(JSON.parse(JSON.stringify(type))), 'unknown');
  });
}
