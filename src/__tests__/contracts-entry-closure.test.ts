import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eagerClosureOf, eagerlyEvaluatedModules } from './eager-import-closure.fixtures.ts';

/**
 * `@agent-device/contracts/platform` and `/interaction` union 32 and 18 vocabulary
 * modules. A file that value-imports either one evaluates the whole union to reach a
 * single function, and because permanent hubs sat behind them (#1959) that union rode
 * into ~470 of the suite's ~970 test graphs.
 *
 * Every one of those modules now has its own entry subpath, so the narrow import is
 * always available. These two tests keep it that way from both directions: the first
 * pins the four hubs the issue named, and the second closes the general case so the
 * clump cannot re-form behind a hub nobody thought to list.
 *
 * Type-only importers are untouched and stay legal — `import type` is erased, so it
 * evaluates nothing. That is the same distinction the walker itself draws, which is
 * why this reads the AST through it rather than matching specifier text.
 */

const repoRoot = path.resolve(import.meta.dirname, '../..');
const CLUMP_ENTRIES = [
  '@agent-device/contracts/platform',
  '@agent-device/contracts/interaction',
] as const;
const CLUMP_FACADES = [
  'packages/contracts/src/facades/platform.ts',
  'packages/contracts/src/facades/interaction.ts',
].map((file) => path.resolve(repoRoot, file));

const HUBS = [
  'src/core/command-descriptor/registry.ts',
  'src/core/capabilities.ts',
  'src/core/interactors/register-builtins.ts',
  'src/core/command-descriptor/platform-execution-entry.ts',
];

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else if (entry.name.endsWith('.ts')) found.push(full);
    }
  };
  walk(path.join(repoRoot, 'src'));
  for (const pkg of fs.readdirSync(path.join(repoRoot, 'packages'))) {
    const src = path.join(repoRoot, 'packages', pkg, 'src');
    if (fs.existsSync(src)) walk(src);
  }
  return found;
}

test('the hubs behind the contracts clump never evaluate either wide facade', () => {
  const offenders = HUBS.flatMap((hub) => {
    const carried = eagerClosureOf(path.resolve(repoRoot, hub)).filter((file) =>
      CLUMP_FACADES.includes(file),
    );
    return carried.map((file) => `${hub} -> ${path.relative(repoRoot, file)}`);
  });

  expect(
    offenders,
    'These hubs sit in hundreds of test graphs, so whatever they evaluate, the suite pays for ' +
      'everywhere. Import the symbol from the vocabulary module that owns it ' +
      '(@agent-device/contracts/<module>) instead of the wide facade.',
  ).toEqual([]);
});

test('no source file value-imports the wide contracts facades', () => {
  const offenders: string[] = [];
  let typeOnlyImporters = 0;
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    // Text-filter before parsing: a file that never names the specifier cannot import
    // it, and parsing all ~3000 sources costs more than the unit lane's budget allows.
    const mentions = CLUMP_ENTRIES.filter((entry) => source.includes(`${entry}'`));
    if (mentions.length === 0) continue;
    const evaluated = new Set(eagerlyEvaluatedModules(file, source));
    for (const entry of mentions) {
      if (evaluated.has(entry)) offenders.push(`${path.relative(repoRoot, file)} -> ${entry}`);
      else typeOnlyImporters += 1;
    }
  }

  // Non-vacuity: an empty offender list also describes a scan that parsed nothing, so
  // require that the surviving type-only importers were seen and classified as erased.
  expect(typeOnlyImporters).toBeGreaterThan(300);
  expect(
    offenders.sort(),
    'Value-importing these facades evaluates every module they re-export from. Each of those ' +
      'modules has its own entry subpath in packages/contracts/package.json — import from that. ' +
      '`import type` from the facades stays fine: it is erased, so it evaluates nothing.',
  ).toEqual([]);
});
