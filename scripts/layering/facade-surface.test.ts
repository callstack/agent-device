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
import {
  readDirectNamedExports,
  readFacadeReExportEdgesByModule,
  readNamedExports,
} from './facade-exports.ts';
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
  // The comparison is PER SOURCE MODULE, not over one collapsed name set: when two
  // re-exported modules export the same name, a flat set lets the survivor's edge
  // hide the dropped one, so narrowing a single source passes (#3289 cubic review
  // P2). Each edge is matched against the module it comes from, by the name the
  // source declares it under — so `export { a as b } from './m.ts'` satisfies `a`,
  // not `b` — and a `namespace:<ns>` binding carries that module's whole surface.
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
    const facadeSource = fs.readFileSync(absolute, 'utf8');
    const dropped = droppedFacadeExports(
      facadeSource,
      (sourcePath) =>
        fs.existsSync(sourcePath)
          ? readDirectNamedExports(fs.readFileSync(sourcePath, 'utf8'))
          : undefined,
      path.dirname(absolute),
    );
    for (const { specifier, names } of dropped) {
      assert.deepEqual(
        names,
        [],
        `${file} re-exports from ${specifier} but omits ${names.join(', ')} — an explicit ` +
          'façade list must stay exhaustive over its sources, or a symbol added upstream ' +
          'silently never becomes public. Add the names, or move them out of that module.',
      );
    }
  }
});

/**
 * Per-source exhaustiveness: for each module the façade re-exports from, the
 * names that module declares but no edge from THAT module carries. Factored
 * from the real-tree loop so the narrowed-source case can be planted against a
 * name duplicated in a sibling module (#3289 cubic review P2). `sourceNamesOf`
 * reads one resolved source file (undefined = the specifier resolves to nothing
 * on disk); a `namespace:<ns>` binding exempts its module (whole-surface).
 */
function droppedFacadeExports(
  facadeSource: string,
  sourceNamesOf: (resolvedSourcePath: string) => string[] | undefined,
  facadeDirectory: string,
): { specifier: string; names: string[] }[] {
  const findings: { specifier: string; names: string[] }[] = [];
  const edgesByModule = readFacadeReExportEdgesByModule(facadeSource);
  for (const [specifier, edges] of edgesByModule) {
    if (!specifier.startsWith('.')) continue;
    if (edges.some((edge) => edge.imported.startsWith('namespace:'))) continue;
    const sourceNames = sourceNamesOf(path.resolve(facadeDirectory, specifier));
    if (sourceNames === undefined) continue;
    const imported = new Set(edges.map((edge) => edge.imported));
    const names = sourceNames.filter((name) => name !== 'default' && !imported.has(name));
    if (names.length > 0) findings.push({ specifier, names });
  }
  return findings;
}

test('a narrowed source fails even when a sibling module exports the same name', () => {
  // The planted #3289 cubic review P2. `./widgets.ts` lost `Dropped` from the
  // façade while `./other.ts` still publishes the same name. The old check
  // collapsed every module's re-exports into one export-NAME set, so
  // `Dropped`-from-`other` satisfied the missing `Dropped`-from-`widgets` and
  // the narrowing passed. Per-module edges cannot be fooled: the only edges
  // whose module is `./widgets.ts` carry Thing and alpha, so its `Dropped` is
  // reported — and it is reported for THAT module only.
  const facadeSource = [
    "export { Thing, alpha } from './widgets.ts';",
    "export { Dropped } from './other.ts';",
  ].join('\n');
  const sourceNames = new Map<string, string[]>([
    ['/virtual/facades/widgets.ts', ['Thing', 'alpha', 'Dropped']],
    ['/virtual/facades/other.ts', ['Dropped']],
  ]);
  assert.deepEqual(
    droppedFacadeExports(facadeSource, (resolved) => sourceNames.get(resolved), '/virtual/facades'),
    [{ specifier: './widgets.ts', names: ['Dropped'] }],
  );
  // The matching direction for aliases is the SOURCE name: `alpha as aliasAlpha`
  // covers widgets' `alpha`. Were the façade-side name compared instead,
  // `alpha` would surface as a second drop.
  const aliasSource = [
    "export { Thing, alpha as aliasAlpha } from './widgets.ts';",
    "export { Dropped } from './other.ts';",
  ].join('\n');
  assert.deepEqual(
    droppedFacadeExports(aliasSource, (resolved) => sourceNames.get(resolved), '/virtual/facades'),
    [{ specifier: './widgets.ts', names: ['Dropped'] }],
  );
});
