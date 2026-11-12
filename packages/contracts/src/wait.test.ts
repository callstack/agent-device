import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { matchesWaitText } from './wait.ts';

// Golden `wait text` table: the Swift runner's native findText predicate is asserted against the
// same JSON (RunnerTests+WaitTextPolicyTests.swift).
type WaitTextCase = {
  name: string;
  text: string;
  node: { editable?: boolean; label?: string; value?: string; identifier?: string };
  expected: boolean;
};

const TABLE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'contracts',
  'fixtures',
  'wait-text-policy.json',
);

test('wait text matches visible text but not an editable field’s typed content', () => {
  const cases = JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8')) as WaitTextCase[];
  assert.ok(cases.length > 0, 'wait text policy table must not be empty');
  for (const fixture of cases) {
    assert.equal(matchesWaitText(fixture.node, fixture.text), fixture.expected, fixture.name);
  }
});
