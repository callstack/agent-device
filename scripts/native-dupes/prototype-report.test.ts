import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countMotivatingClones, namedConstantRange } from './prototype-report.ts';

const source = `// const IPHONE_DUO_CLOSED = "😀 comment, not the fixture";
const other = { nativeSize: [1, 2] };
const IPHONE_DUO_CLOSED = JSON.stringify({
  result: {
    displays: [
      { active: true, nativeSize: [1398, 2034] },
      { active: false, nativeSize: [2007, 2853] },
    ],
  },
});
const singlePanel = { active: true };
`;

test('Duo range follows its named constant after line shifts and ignores comment decoys', () => {
  assert.deepEqual(namedConstantRange(source, 'IPHONE_DUO_CLOSED'), { start: 3, end: 10 });
  assert.deepEqual(namedConstantRange('\n'.repeat(40) + source, 'IPHONE_DUO_CLOSED'), {
    start: 43,
    end: 50,
  });
  assert.throws(() => namedConstantRange(source, 'RENAMED_FIXTURE'), /RENAMED_FIXTURE/);
});

for (const separator of ['/', '\\']) {
  test(`motivating clone counts accept ${JSON.stringify(separator)} paths and shifted fixture lines`, () => {
    const target = ['checkout', 'simctl-facade.test.ts'].join(separator);
    const other = ['checkout', 'display-inventory.test.ts'].join(separator);
    const fold = ['checkout', 'apple', 'fold-helper', 'Fold.m'].join(separator);
    const counts = countMotivatingClones(
      [
        {
          firstFile: { name: fold, start: 2, end: 8 },
          secondFile: { name: fold, start: 12, end: 18 },
        },
        {
          firstFile: { name: target, start: 45, end: 47 },
          secondFile: { name: other, start: 70, end: 72 },
        },
        {
          firstFile: { name: other, start: 73, end: 75 },
          secondFile: { name: target, start: 48, end: 50 },
        },
        {
          firstFile: { name: target, start: 51, end: 60 },
          secondFile: { name: other, start: 80, end: 89 },
        },
        {
          firstFile: { name: target, start: 41, end: 42 },
          secondFile: { name: other, start: 5, end: 6 },
        },
        {
          firstFile: { name: target, start: 45, end: 47 },
          secondFile: { name: target, start: 48, end: 50 },
        },
      ],
      namedConstantRange('\n'.repeat(40) + source, 'IPHONE_DUO_CLOSED'),
    );
    assert.deepEqual(counts, { fold: 1, duoPanels: 2 });
  });
}
