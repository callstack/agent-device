import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
  androidFieldValue,
  isFillableType,
  isNativeIosSnapshotBarNode,
  snapshotBarKind,
} from './snapshot-text.ts';

const fieldValues = JSON.parse(
  readFileSync(
    new URL('../../../contracts/fixtures/android-field-values.json', import.meta.url),
    'utf8',
  ),
) as {
  cases: { name: string; input: Parameters<typeof androidFieldValue>[0]; value: string | null }[];
};

test.each(fieldValues.cases)('Android field value contract: $name', ({ input, value }) => {
  expect(androidFieldValue(input)).toBe(value ?? undefined);
});

test('unknown fillable type does not establish Android field content', () => {
  expect(isFillableType('', 'android')).toBe(true);
  expect(androidFieldValue({ type: '', text: 'Static label' })).toBeUndefined();
});

test('a web text input is fillable by its ARIA role, a button is not', () => {
  expect(isFillableType('textbox', 'web')).toBe(true);
  expect(isFillableType('searchbox', 'web')).toBe(true);
  expect(isFillableType('button', 'web')).toBe(false);
});

// The full bar identity lives here, bottom navigation included, so consumers that publish a
// persistent-bar fact read one vocabulary instead of matching platform role strings themselves.
test.each([
  { name: 'an iOS tab bar type', node: { type: 'TabBar' }, kind: 'tab-bar' },
  {
    name: 'a UIKit class in role beside a generic type',
    node: { type: 'Other', role: 'UINavigationBar' },
    kind: 'navigation-bar',
  },
  {
    name: 'a toolbar in subrole only',
    node: { type: 'Other', subrole: 'AXToolbar' },
    kind: 'toolbar',
  },
  {
    name: 'an Android bottom navigation view',
    node: { type: 'com.google.android.material.bottomnavigation.BottomNavigationView' },
    kind: 'bottom-navigation',
  },
  {
    name: 'a bottom navigation bar named in role only',
    node: { type: 'Other', role: 'BottomNavigationBar' },
    kind: 'bottom-navigation',
  },
])('snapshotBarKind reads $name', ({ node, kind }) => {
  expect(snapshotBarKind(node)).toBe(kind);
  expect(isNativeIosSnapshotBarNode(node)).toBe(kind !== 'bottom-navigation');
});

test.each([
  { type: 'Button', role: 'UIButton' },
  { type: 'HomeToolbarView' },
  { type: 'Other', role: 'BottomTabBar' },
])('a non-bar node reads no bar kind for %j', (node) => {
  expect(snapshotBarKind(node)).toBeUndefined();
  expect(isNativeIosSnapshotBarNode(node)).toBe(false);
});
