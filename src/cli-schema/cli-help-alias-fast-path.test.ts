// Pins the exact composition `bin.ts`'s `--help` fast path relies on:
// `buildCommandUsageText(normalizeCliCommandAlias(helpTarget))`. Before this
// fix, `bin.ts` used its own hand-written two-entry table instead of this
// composition, so `tap`, `launch`, and `relaunch` silently missed the fast
// path and fell through to a full CLI bootstrap just to print static help
// text. `bin.ts` runs unguarded top-level dispatch on import (and is
// deliberately excluded from coverage — see vitest.config.ts), so it cannot
// be imported directly in a test; these tests instead pin the registry
// composition it calls. That makes them a real regression pin for a *future*
// alias missing help text (test 2 is durable for that), but not a substitute
// for the manual proof, run outside this suite, that bin.ts itself calls
// this composition (see the plan's execution report for the red/green
// evidence: with the stale table, `tap --help` loads `src/cli.ts`; with this
// fix, it does not).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildCommandUsageText } from './cli-help.ts';
import { cliAliasesForCommand, normalizeCliCommandAlias } from '../commands/cli-command-aliases.ts';
import { listCliCommandNames } from '../command-catalog.ts';

test('alias help output matches its canonical command', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['tap', 'press'],
    ['launch', 'open'],
    ['relaunch', 'open'],
    ['long-press', 'longpress'],
  ];
  for (const [alias, canonical] of cases) {
    const aliasHelp = buildCommandUsageText(normalizeCliCommandAlias(alias));
    const canonicalHelp = buildCommandUsageText(canonical);
    assert.notEqual(aliasHelp, null, `expected help text for alias "${alias}"`);
    assert.equal(
      aliasHelp,
      canonicalHelp,
      `expected "${alias} --help" to be byte-identical to "${canonical} --help"`,
    );
  }
});

test('every CLI alias resolves to a command with help text', () => {
  // Derive the alias list from the registry itself (via the canonical
  // commands it targets) rather than hard-coding the five current alias
  // names — a hard-coded list would silently stop covering a future sixth
  // alias, reintroducing exactly the drift this test exists to catch.
  const aliases = listCliCommandNames().flatMap((command) =>
    cliAliasesForCommand(command).map((entry) => entry.alias),
  );
  assert.ok(aliases.length > 0, 'expected at least one alias to exercise this test');
  for (const alias of aliases) {
    const help = buildCommandUsageText(normalizeCliCommandAlias(alias));
    assert.notEqual(help, null, `expected buildCommandUsageText to resolve alias "${alias}"`);
  }
});

test('rotate still has no fast-path help', () => {
  // `rotate` is not in the alias registry, so it must fall through to the
  // slow path (`src/cli/parser/args.ts`'s `normalizeCommandAlias`), which is
  // where the "renamed to orientation" migration error is raised. The fast
  // path must never special-case `rotate` itself.
  const help = buildCommandUsageText(normalizeCliCommandAlias('rotate'));
  assert.equal(help, null);
});
