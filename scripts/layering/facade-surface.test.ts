// The workspace façades' public surface: every entry file names its exports
// explicitly, its lists stay exhaustive over their sources, and the moves here
// stay owned. These real-tree structural gates mirror the façade question, not
// the R11 rule internals (package-boundaries.test.ts) or the export-form
// parser (facade-exports.test.ts); they were split out when the R11 family
// crossed the test-size tripwire, move-only.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { listSourceFiles } from './check.ts';
import { readDirectNamedExports, readNamedExports } from './facade-exports.ts';
import { facadeEntryFiles } from './package-boundaries.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

test('every workspace package façade names its exports explicitly (no bare `export *`)', () => {
  // #1574 built a hand-maintained pin table (`facade-symbols.ts`, 816 symbols across every
  // workspace-package façade) plus a ~200-line star-chain resolver (`readFacadeExports`) whose
  // entire job was enumerating what `export *` hides. Once a façade names its exports explicitly,
  // the façade file itself IS the pin — a widening shows up in the diff of the file that grew,
  // not in a table two files away that only a gate failure would surface. This structural gate is
  // what keeps that property true: every façade a package manifest declares (`exportTargets`),
  // plus every production file under a `src/facades/` directory, must parse through
  // `readNamedExports` without hitting the bare-`export *`/`export default` rejection it already
  // implements — reusing that check rather than writing a second, regex-based one that would have
  // to independently rediscover every export form to be trustworthy.
  //
  // The façade set comes from `facadeEntryFiles`, the single owner of "what is an entry surface".
  // The ADR-0019 eager-closure budget table consumes the same function, so a file this gate holds
  // to an explicit export list is necessarily a file that gate holds to a loading-shape budget.
  const facadeFiles = facadeEntryFiles(repoRoot);
  assert.ok(facadeFiles.length > 0, 'expected at least one workspace package façade to check');
  for (const file of facadeFiles) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    try {
      readNamedExports(source);
    } catch (error) {
      assert.fail(
        `${file} must name its exports explicitly instead of a bare \`export *\` (or an ` +
          '`export default`) — a façade widened by a star re-export hides the new symbol from ' +
          'its own diff, exactly what the retired symbol-pin table (#1574) used to catch by ' +
          `hand. Underlying error: ${(error as Error).message}`,
      );
    }
  }
});

test('every façade re-exports its sources exhaustively (no silent narrowing)', () => {
  // The star-rejection above catches a façade WIDENING invisibly. This catches the
  // opposite, which is the failure an explicit list makes newly possible: a symbol
  // added to a source module simply never reaches the façade, and nothing notices.
  // `export *` could not narrow by construction; an explicit list can, so the
  // property `export *` gave for free is asserted here instead.
  //
  // Found by review on #1614: this conversion was generated against the surface at
  // fork time, and #1567 landed 13 new exports meanwhile (`DragOptions`, the drag
  // gesture vocabulary, `MultiTargetAnnotationV1`). The rebase silently dropped all
  // 13 and only a human diff caught it. Exhaustiveness is what makes that mechanical.
  //
  // Scoped to `packages/*/src/facades/` — the barrels this PR converted, which were
  // exhaustive by construction because `export *` cannot narrow. A hand-curated
  // package `index.ts` is a different thing: `@agent-device/ad-replay` deliberately
  // publishes two values out of a much larger `internal/`, and forcing it exhaustive
  // would widen a surface its owner narrowed on purpose (#1555).
  const facadeFiles = listSourceFiles().filter((file) => file.includes('/src/facades/'));
  assert.ok(facadeFiles.length > 0, 'expected at least one converted façade to check');
  for (const file of [...facadeFiles].sort()) {
    const absolute = path.join(repoRoot, file);
    const exported = new Set(readNamedExports(fs.readFileSync(absolute, 'utf8')));
    for (const specifier of reExportSources(fs.readFileSync(absolute, 'utf8'))) {
      const sourcePath = path.resolve(path.dirname(absolute), specifier);
      if (!fs.existsSync(sourcePath)) continue;
      // A source may itself carry a bare `export *` (contracts' `gesture-plan.ts`
      // stars `gesture-plan-types.ts`). Read its DIRECT exports rather than skipping
      // the file: skipping would also drop `buildDragGesturePlan` and friends from
      // this check, so removing one from a façade would narrow the surface silently
      // (#1614 review P2). The starred names are covered because the façade
      // re-exports the starred module directly too, and that path is checked here on
      // its own turn.
      const sourceNames = readDirectNamedExports(fs.readFileSync(sourcePath, 'utf8'));
      const dropped = sourceNames.filter((name) => name !== 'default' && !exported.has(name));
      assert.deepEqual(
        dropped,
        [],
        `${file} re-exports from ${specifier} but omits ${dropped.join(', ')} — an explicit ` +
          'façade list must stay exhaustive over its sources, or a symbol added upstream ' +
          'silently never becomes public. Add the names, or move them out of that module.',
      );
    }
  }
});

/** The relative specifiers a façade re-exports from, in source order. */
function reExportSources(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/\bfrom\s+'(\.[^']*)'/g)) {
    const specifier = match[1];
    if (specifier) found.add(specifier);
  }
  return [...found];
}
