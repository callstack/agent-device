import { expect, test } from 'vitest';
import { readAndroidTextAtPointInHierarchy } from './fill-verification.ts';
const row = (id: string, text: string, bounds: string) =>
  `<node package="com.example" resource-id="${id}" class="android.widget.TextView" text="${text}" bounds="${bounds}"/>`;
const identity = {
  identifier: 'com.example:id/title',
  bundleId: 'com.example',
  type: 'android.widget.TextView',
};

test('a shared row resource id uses the live text at the requested point', () => {
  const xml = `<hierarchy>${row(identity.identifier, 'first live', '[0,0][200,100]')}${row(identity.identifier, 'second live', '[0,100][200,200]')}</hierarchy>`;
  expect(readAndroidTextAtPointInHierarchy(xml, 10, 150, identity)).toBe('second live');
});

test('a missing or ambiguous identity preserves a readable point', () => {
  const xml = `<hierarchy>${row(identity.identifier, 'first', '[0,0][200,100]')}${row(identity.identifier, 'second', '[0,100][200,200]')}${row('other', 'point value', '[0,200][200,300]')}</hierarchy>`;
  expect(readAndroidTextAtPointInHierarchy(xml, 10, 250, identity)).toBe('point value');
  expect(
    readAndroidTextAtPointInHierarchy(xml, 10, 250, { ...identity, identifier: 'missing' }),
  ).toBe('point value');
});

test('a unique identity can still read a field that moved away from the recorded point', () => {
  const xml = `<hierarchy>${row(identity.identifier, 'moved live', '[0,100][200,200]')}</hierarchy>`;
  expect(readAndroidTextAtPointInHierarchy(xml, 10, 10, identity)).toBe('moved live');
});
