import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { matchesWaitText } from './node.ts';

// Golden `wait text` table: the Swift runner's native findText predicate is asserted against the
// same JSON (UnitTests/RunnerTests+InteractionTests.swift).
type WaitTextCase = {
  name: string;
  platform?: 'android' | 'web';
  text: string;
  node: Omit<SnapshotNode, 'index' | 'ref'>;
  expected: boolean;
};

const TABLE_PATH = path.resolve(
  import.meta.dirname,
  '..',
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
    const node = { index: 0, ref: 'e1', type: 'StaticText', ...fixture.node };
    assert.equal(
      matchesWaitText(node, fixture.text, fixture.platform ?? 'ios'),
      fixture.expected,
      fixture.name,
    );
  }
});
