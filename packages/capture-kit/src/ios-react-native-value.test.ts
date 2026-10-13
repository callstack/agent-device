import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import fc from 'fast-check';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { interpretIosReactNativeValue } from './ios-react-native-value.ts';

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../contracts/fixtures/ios-react-native-value-semantics.json', import.meta.url),
    'utf8',
  ),
) as {
  cases: {
    name: string;
    renderer: string;
    locale: string;
    node: RawSnapshotNode;
    expected: Partial<RawSnapshotNode>;
  }[];
};
for (const entry of fixture.cases) {
  test(`${entry.renderer}/${entry.locale}: ${entry.name}`, () => {
    const before = structuredClone(entry.node);
    assert.deepEqual(interpretIosReactNativeValue(entry.node), {
      ...entry.node,
      ...entry.expected,
    });
    assert.deepEqual(entry.node, before);
  });
}

test('preserves arbitrary native-control values and identities', () => {
  fc.assert(
    fc.property(
      fc.string(),
      fc.constantFrom('TextField', 'Switch', 'Button', 'StaticText'),
      (value, type) => {
        const node = { index: 0, type, value };
        const before = structuredClone(node);
        assert.equal(interpretIosReactNativeValue(node), node);
        assert.deepEqual(node, before);
      },
    ),
    { numRuns: 100 },
  );
});

test('preserves raw checked facts and arbitrary suffixes without mutating or reinterpreting', () => {
  fc.assert(
    fc.property(fc.boolean(), fc.string(), (checked, suffix) => {
      const node = {
        index: 0,
        type: 'Other',
        value: `checkbox, mixed, payload:${suffix}`,
        checked,
      };
      const before = structuredClone(node);
      const result = interpretIosReactNativeValue(node);
      assert.deepEqual(node, before);
      assert.equal(result.value, before.value);
      assert.equal(result.checked, before.checked);
      assert.equal(result.iosValueSemantics?.checked, 'mixed');
      assert.equal(interpretIosReactNativeValue(result), result);
    }),
    { numRuns: 100 },
  );
});
