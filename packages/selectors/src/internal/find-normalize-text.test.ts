import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeText } from './find.ts';

// Golden text normalization table: the Swift runner's `selectorText`, which decides whether iOS back
// lists a dismiss control's selector as unique, is asserted against the same JSON
// (UnitTests/RunnerTests+NavigationTests.swift).
type NormalizationCase = { name: string; input: string; normalized: string };

const TABLE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'contracts',
  'fixtures',
  'selector-text-normalization.json',
);

test('selector text normalization matches the shared table', () => {
  const cases = JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8')) as NormalizationCase[];
  assert.ok(cases.length > 0, 'the normalization table must not be empty');
  for (const fixture of cases) {
    assert.equal(normalizeText(fixture.input), fixture.normalized, fixture.name);
  }
});
