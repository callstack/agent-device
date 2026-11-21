import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { listCliCommandNames } from '@agent-device/command-registry/catalog';
import { collectReasonTables, reasonTableProblems } from '../../scripts/reasons/collect.ts';
import { PAGE_PATH, collectRepoReasonTables, renderPage } from '../../scripts/reasons/generate.ts';

// Every published reason table, found by its `satisfies ReasonTable` marker: one owner per reason
// value, real CLI commands only, and an error reasons page that matches the tables.

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const cliCommands = new Set<string>(listCliCommandNames());

test('the reason tables declare each reason once, name real commands, and match the page', () => {
  const tables = collectRepoReasonTables(REPO_ROOT);
  assert.ok(tables.length > 0);
  assert.deepEqual(reasonTableProblems(tables, cliCommands), []);
  const committed = fs.readFileSync(path.join(REPO_ROOT, PAGE_PATH), 'utf8');
  assert.ok(
    committed === renderPage(tables, cliCommands),
    `${PAGE_PATH} is stale. Run \`pnpm generate:reasons\`.`,
  );
});

const collect = (files: Record<string, string>) =>
  collectReasonTables(new Map(Object.entries(files)));

test('a marked table is collected exported or not, with its owner; an unmarked one is not', () => {
  const tables = collect({
    'packages/a/src/a.ts': `
      const LOCAL = {
        // Busy.
        busy: { reason: 'a_busy', commands: ['close'] },
      } as const satisfies ReasonTable<'open'>;
      export const SHARED = {
        /** Maintainer docs, not the summary. */
        // Gone,
        // across two lines.
        gone: { reason: \`A_GONE\` },
      } as const satisfies ReasonTable<'leases'>;
      const UNMARKED = { other: { reason: 'a_other' } } as const;
    `,
    'packages/a/src/__tests__/fixture.ts': `
      const TEST_ONLY = { x: { reason: 'x' } } as const satisfies ReasonTable<'t'>;
    `,
  });
  assert.deepEqual(
    tables.map(({ name, owner, rows }) => ({ name, owner, rows })),
    [
      {
        name: 'LOCAL',
        owner: 'open',
        rows: [{ member: 'busy', reason: 'a_busy', summary: 'Busy.', commands: ['close'] }],
      },
      {
        name: 'SHARED',
        owner: 'leases',
        rows: [
          { member: 'gone', reason: 'A_GONE', summary: 'Gone, across two lines.', commands: [] },
        ],
      },
    ],
  );
});

test('a row the collector cannot read fails the scan instead of being dropped', () => {
  const table = (rows: string, marker = 'as const satisfies ReasonTable<"open">') =>
    `const T = {\n// A.\n${rows} } ${marker};`;
  for (const [source, problem] of [
    [table(`a: { reason: R.a }`), /`reason` as a literal/],
    [table(`a: { reason: 'a', commands: [OPEN] }`), /`commands` as string literals/],
    [table(`a: ROW`), /named row object literal/],
    [table(`a: { reason: 'a' }`, 'satisfies ReasonTable<"s">'), /as const/],
    [table(`a: { reason: 'a' }`, 'as const satisfies ReasonTable<S>'), /owner/],
    [table(`a: { reason: 'a' }`, 'as const satisfies ReasonTable'), /owner/],
    [
      `const T = { /** Docs only. */ a: { reason: 'a' } } as const satisfies ReasonTable<"open">;`,
      /needs a comment/,
    ],
  ] as const) {
    assert.throws(() => collect({ 'src/t.ts': source }), problem);
  }
});

test('a duplicated reason value, a command the CLI lacks, and an empty table are problems', () => {
  const tables = collect({
    'packages/a/src/a.ts': `const A = {
      // One.
      one: { reason: 'dup', commands: ['open'] },
      // Two.
      two: { reason: 'unique', commands: ['no-such-command'] },
    } as const satisfies ReasonTable<'open'>;`,
    'packages/b/src/b.ts': `const B = { // One.
      one: { reason: 'dup' } } as const satisfies ReasonTable<'s'>;`,
    'packages/c/src/c.ts': `const C = {} as const satisfies ReasonTable<'s'>;`,
  });
  const problems = reasonTableProblems(tables, cliCommands);
  assert.equal(problems.length, 3);
  assert.match(problems[0]!, /C \(packages\/c\/src\/c\.ts\) declares no reason/);
  assert.match(problems[1]!, /A\.two \(packages\/a\/src\/a\.ts\) names "no-such-command"/);
  assert.match(problems[2]!, /"dup" is declared by A\.one .* and B\.one/);
  assert.deepEqual(reasonTableProblems([tables[1]!], cliCommands), []);
});

test('the page groups rows under their owner command or subsystem, and each other command they name', () => {
  const page = renderPage(
    collect({
      'packages/a/src/a.ts': `const A = {
        // One | two.
      one: { reason: 'r_one', commands: ['close'] },
      } as const satisfies ReasonTable<'open'>;
      const B = { // Two.
      two: { reason: 'r_two', commands: ['open'] } } as const satisfies ReasonTable<'leases'>;`,
    }),
    cliCommands,
  );
  const section = (heading: string) => page.split(`### ${heading}\n`)[1]!.split('\n\n')[0]!.trim();
  assert.equal(
    section('`close`'),
    '| Reason | Meaning |\n| --- | --- |\n| `r_one` | One \\| two. |',
  );
  assert.match(section('`open`'), /r_one/);
  assert.match(section('`open`'), /r_two/);
  assert.match(section('Leases'), /\| `r_two` \| Two\. \|/);
});
