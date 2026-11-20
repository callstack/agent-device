import assert from 'node:assert/strict';
import { test } from 'vitest';
import { listCliCommandNames } from '@agent-device/command-registry/catalog';
import { publishedReasonsOf } from '../../scripts/command-docs/reasons.ts';

/**
 * A reason has one declaration. Two rows with the same value, in one table or in two, would give
 * the reason two owners, and the command reference would list it under both.
 */
test('every published reason of a command reason table has exactly one owning command', () => {
  const owners = new Map<string, string[]>();
  for (const command of listCliCommandNames()) {
    for (const reason of publishedReasonsOf(command)) {
      owners.set(reason, [...(owners.get(reason) ?? []), command]);
    }
  }
  assert.equal(owners.get('scroll_no_progress')?.join(), 'scroll');
  assert.deepEqual(
    [...owners].filter(([, commands]) => commands.length > 1),
    [],
  );
});
