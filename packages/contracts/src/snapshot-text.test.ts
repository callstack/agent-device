import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { androidFieldValue, isFillableType } from './snapshot-text.ts';

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
