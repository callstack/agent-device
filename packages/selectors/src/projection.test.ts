import { expect, test } from 'vitest';
import { projectSelectorExpression } from './index.ts';

test('projects configured text aliases into the consumer vocabulary', () => {
  expect(
    projectSelectorExpression('label="Save"', {
      textKeys: ['id', 'text'],
      booleanKeys: ['enabled'],
      textAliases: { label: 'text' },
    }),
  ).toEqual({ text: 'Save' });
  expect(
    projectSelectorExpression('label="Save" enabled=true', {
      textKeys: ['id', 'text'],
      booleanKeys: ['enabled'],
      textAliases: { label: 'text' },
    }),
  ).toEqual({ text: 'Save', enabled: true });
});
