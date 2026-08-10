import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assessToolingSimplicity,
  hasSubstantiveSimplicityReview,
  parseNumstat,
} from './tooling-simplicity-review-model.ts';

test('parses text numstat entries and ignores binary files', () => {
  assert.deepEqual(parseNumstat('12\t3\tscripts/check.ts\n-\t-\tfixtures/image.png\n'), [
    { additions: 12, path: 'scripts/check.ts' },
  ]);
});

test('ordinary product tests and fixture data do not trigger the tooling review', () => {
  const assessment = assessToolingSimplicity([
    { additions: 1_200, path: 'src/__tests__/behavior.test.ts' },
    { additions: 2_000, path: 'scripts/tool/fixtures/ledger.json' },
  ]);

  assert.equal(assessment.requiresReview, false);
  assert.equal(assessment.implementationAdditions, 0);
});

test('500 lines of custom tooling implementation trigger review', () => {
  const assessment = assessToolingSimplicity([
    { additions: 320, path: 'scripts/wire-guard/model.ts' },
    { additions: 180, path: 'test/wire-guard/surface.ts' },
  ]);

  assert.equal(assessment.requiresReview, true);
  assert.equal(assessment.implementationAdditions, 500);
  assert.match(assessment.reasons[0] ?? '', /500 custom tooling implementation lines/);
});

test('workflow and composite-action definitions count as custom tooling', () => {
  const assessment = assessToolingSimplicity([
    { additions: 300, path: '.github/workflows/custom-gate.yml' },
    { additions: 200, path: '.github/actions/custom-gate/action.yaml' },
  ]);

  assert.equal(assessment.requiresReview, true);
  assert.equal(assessment.implementationAdditions, 500);
});

test('1,000 combined tooling and test lines trigger review when implementation is present', () => {
  const assessment = assessToolingSimplicity([
    { additions: 250, path: 'scripts/wire-guard/model.ts' },
    { additions: 750, path: 'scripts/wire-guard/model.test.ts' },
  ]);

  assert.equal(assessment.requiresReview, true);
  assert.equal(assessment.implementationAdditions, 250);
  assert.equal(assessment.testAdditions, 750);
  assert.match(assessment.reasons[0] ?? '', /1,000 combined implementation and test lines/);
});

test('generated data and fixtures are excluded from both counts', () => {
  const assessment = assessToolingSimplicity([
    { additions: 800, path: 'scripts/wire-guard/fixtures/generated.ts' },
    { additions: 800, path: 'test/wire-guard/snapshots/output.test.ts' },
  ]);

  assert.deepEqual(assessment, {
    implementationAdditions: 0,
    testAdditions: 0,
    requiresReview: false,
    reasons: [],
    implementationFiles: [],
  });
});

test('review section must contain a substantive explanation outside comments', () => {
  assert.equal(
    hasSubstantiveSimplicityReview('## Simplicity review\n<!-- placeholder -->\n'),
    false,
  );
  assert.equal(
    hasSubstantiveSimplicityReview(
      '## Simplicity review\n' +
        'The registry is authoritative. Types cannot compare released files, so this guard checks the boundary. ' +
        'Delete it when the schema owns compatibility.\n\n## Validation\nCI',
    ),
    true,
  );
});
