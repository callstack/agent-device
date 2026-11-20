import assert from 'node:assert/strict';
import { test } from 'vitest';
import { listCliCommandNames } from '@agent-device/command-registry/catalog';
import { SCROLL_REASONS } from '@agent-device/contracts/scroll-reasons';

/** Every command reason table. A family registers its table here when it declares one. */
const COMMAND_REASON_TABLES = { SCROLL_REASONS };

/**
 * A reason has one declaration and one owner. Two rows with the same value would give the reason
 * two owners, and a row naming no CLI command would give it none.
 */
test('every row of a command reason table names a CLI command and a reason no other row has', () => {
  const commands = new Set<string>(listCliCommandNames());
  const owners = new Map<string, string[]>();
  for (const [tableName, table] of Object.entries(COMMAND_REASON_TABLES)) {
    for (const [member, row] of Object.entries(table)) {
      assert.ok(commands.has(row.command), `${tableName}.${member} names "${row.command}"`);
      owners.set(row.reason, [...(owners.get(row.reason) ?? []), `${tableName}.${member}`]);
    }
  }
  assert.ok(owners.size > 0);
  assert.deepEqual(
    [...owners].filter(([, rows]) => rows.length > 1),
    [],
  );
});
