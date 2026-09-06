import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildCommandUsageText, resolveHelpTargetUsageText } from './cli-help.ts';
import { cliAliasesForCommand } from '../commands/cli-command-aliases.ts';
import { listCliCommandNames } from '@agent-device/command-registry/catalog';

const ALIASES = listCliCommandNames().flatMap((command) =>
  cliAliasesForCommand(command).map((entry) => [entry.alias, command] as const),
);

test('every registered alias resolves to its canonical command help', () => {
  assert.ok(ALIASES.length > 0);
  for (const [alias, canonical] of ALIASES) {
    const help = resolveHelpTargetUsageText(alias);
    assert.notEqual(help, null, alias);
    assert.equal(help, buildCommandUsageText(canonical), alias);
  }
});

test('a retired command has no help text and is left to the full CLI', () => {
  assert.equal(resolveHelpTargetUsageText('rotate'), null);
});
