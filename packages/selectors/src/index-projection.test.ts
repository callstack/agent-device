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

const vocabulary = {
  textKeys: ['id', 'text'],
  booleanKeys: ['enabled'],
  textAliases: { label: 'text' },
};

test('alternatives collapse to one text value only when every branch names it', () => {
  // The one shape a vocabulary without `||` can still express faithfully.
  expect(projectSelectorExpression('text="Save" || label="Save"', vocabulary)).toEqual('Save');
  // A branch that names a different value has no single-text projection.
  expect(projectSelectorExpression('text="Save" || text="Submit"', vocabulary)).toBeNull();
});

test('an alternative branch outside the single-text shape refuses the collapse', () => {
  // A compound branch is not a single text term, so nothing collapses even though the
  // surviving branch is.
  expect(
    projectSelectorExpression('text="Save" enabled=true || text="Save"', vocabulary),
  ).toBeNull();
  // A single-term branch on a non-text key is outside the shape as well.
  expect(projectSelectorExpression('enabled=true || text="Save"', vocabulary)).toBeNull();
});
