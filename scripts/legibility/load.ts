// The one place the legibility inputs are read off the repository. File set and zone partition
// come from the layering gate (`listSourceFiles`, `targetDagZone`), import edges from its
// resolver, test files from its tracked enumeration, first-touch subjects from the shared
// history model, and per-family coupling from the coupling report over that same history.

import fs from 'node:fs';
import path from 'node:path';
import { buildCouplingReport } from '../coupling/report.ts';
import { listSourceFiles, listTypeScriptFiles } from '../layering/check.ts';
import { memoizedImportParser, resolveImportEdges, targetDagZone } from '../layering/model.ts';
import { workspaceSpecifierTargets } from '../layering/package-boundaries.ts';
import { loadRepoHistory } from '../repo-history/load.ts';
import { buildCorpus, type Corpus } from './corpus.ts';
import type { FamilyCoupling } from './score.ts';

export type LegibilityInputs = {
  corpus: Corpus;
  coupling: Map<string, FamilyCoupling>;
  /**
   * Names to scrub per family: the family id, i.e. the answer option itself. A source folder
   * whose name differs from its id (`src/daemon/` for `daemon-server`) stays visible on purpose:
   * the measure asks whether the NAME carries the question, and the folder name is that name.
   * The issue's reference numbers were taken under the same rule.
   */
  namesByFamily: Map<string, string[]>;
};

export function familyNames(corpus: Corpus): Map<string, string[]> {
  return new Map(corpus.families.map((family) => [family, [family]]));
}

export function loadLegibilityInputs(repoRoot: string): LegibilityInputs {
  const files = listSourceFiles();
  const sources = new Map(
    files.map((file) => [file, fs.readFileSync(path.join(repoRoot, file), 'utf8')]),
  );
  const production = new Set(files);
  const testFiles = listTypeScriptFiles().filter((file) => !production.has(file));
  const parse = memoizedImportParser();
  const edges = resolveImportEdges(sources, workspaceSpecifierTargets(repoRoot), parse);
  const history = loadRepoHistory(repoRoot);
  const corpus = buildCorpus({
    sources,
    edges,
    testFiles,
    firstTouch: history.firstTouch,
    familyOf: targetDagZone,
    parse,
  });
  const couplingReport = buildCouplingReport(history, {
    familyOf: targetDagZone,
    sinceDays: 120,
    now: new Date(),
    generated: { commit: 'n/a', date: new Date().toISOString() },
  });
  return {
    corpus,
    coupling: new Map(
      couplingReport.perFamily.map((row) => [row.family, { Q: row.Q, outInFlow: row.outInFlow }]),
    ),
    namesByFamily: familyNames(corpus),
  };
}
