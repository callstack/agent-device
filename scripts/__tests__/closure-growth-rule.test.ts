import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  eagerClosureGraphOf,
  topLevelStatementCount,
  topLevelStatementWeightsOf,
  type SourceTreeReader,
} from '../../src/__tests__/eager-import-closure.fixtures.ts';
import { createCommittedSourceTree } from './committed-source-tree.ts';
import { mkGitFixtureRepo } from './eager-closure-gate-fixtures.ts';
import {
  classifyGrowth,
  closureGrowthEvidence,
  type ClosureGrowthEvidence,
} from './closure-growth-rule.ts';

/**
 * The NO-GROWTH rule and its split tolerance (#2469, ADR 0027), tested in both failing
 * directions. The gate's real-tree lane (`eager-closure-budgets.test.ts`) cannot distinguish a
 * correct tolerance from a vacuous one while the tree happens to contain no splits, so every
 * direction the two facts (containment, flat weight) guard gets its own planted repo here:
 * a pure split that must pass, a split smuggling a new heavy edge that must fail, a swap that
 * drops a merge-base module that must fail at flat weight, and a rename that must not read as a
 * drop.
 */

test('no-growth fails growth with both counts and passes an equal or smaller closure', () => {
  const at = (over: Partial<ClosureGrowthEvidence> = {}) => ({
    baseCount: 42,
    headCount: 42,
    baseWeight: 200,
    headWeight: 200,
    preservedBaseClosure: true,
    ...over,
  });
  expect(classifyGrowth('x.ts', at())).toBeNull();
  expect(classifyGrowth('x.ts', at({ headCount: 40 }))).toBeNull();
  expect(
    classifyGrowth('x.ts', at({ headCount: 43, headWeight: 210 })),
    'count growth with weight growth fails',
  ).toMatch(/evaluates 43 modules.*merge-base evaluated 42/);
  expect(
    classifyGrowth('x.ts', at({ headCount: 43, preservedBaseClosure: false })),
    'count growth that dropped a merge-base module fails even at flat weight',
  ).toMatch(/evaluates 43 modules.*merge-base evaluated 42/);
});

// --- the split tolerance (#2469) -------------------------------------------------------------
// The no-growth rule counts modules, and a split of a hub module is count growth with no new
// eager work -- which made extracting any module inside a gated closure impossible (ADR 0027).
// The tolerance is exactly two facts: the head still evaluates EVERY merge-base module, and the
// closure's total top-level-statement weight did not grow. Both failing directions are planted.

test('a pure split passes: every base module survives and total weight is flat', () => {
  // entry -> hub(8 statements) becomes entry -> hub(wiring only) -> part-a + part-b carrying the
  // declarations: count 2 -> 4, weight unchanged.
  const at = (over: Partial<ClosureGrowthEvidence> = {}) => ({
    baseCount: 2,
    headCount: 4,
    baseWeight: 10,
    headWeight: 10,
    preservedBaseClosure: true,
    ...over,
  });
  expect(classifyGrowth('x.ts', at())).toBeNull();
  expect(classifyGrowth('x.ts', at({ headWeight: 9 })), 'shrinking needs no edit').toBeNull();
});

test('a split smuggling eager work fails and names both the modules and the statements', () => {
  const finding = classifyGrowth('x.ts', {
    baseCount: 2,
    headCount: 4,
    baseWeight: 10,
    headWeight: 14,
    preservedBaseClosure: true,
  });
  expect(finding).toMatch(/evaluates 4 modules.*merge-base evaluated 2/);
  expect(finding).toMatch(/adds 2 module\(s\) and 4 top-level statement\(s\)/);
  expect(finding, 'a pure split must never print the rewrite warning').not.toMatch(/not a split/);
});

test('growth that drops a merge-base module fails even at flat weight: not a split', () => {
  const finding = classifyGrowth('x.ts', {
    baseCount: 2,
    headCount: 4,
    baseWeight: 10,
    headWeight: 10,
    preservedBaseClosure: false,
  });
  expect(finding).toMatch(/evaluates 4 modules.*merge-base evaluated 2/);
  expect(finding).toMatch(/not a split of existing code/);
});

/**
 * A hub repo at two states: the hub commit carrying three declarations, then the working tree
 * holding the pure split of two of them into parts. The smuggle test mutates this state BEFORE
 * its first working-tree walk, because the walker memoizes edges per path -- one walk per repo.
 */
function mkSplitFixtureRepo(prefix: string): {
  repo: string;
  entry: string;
  hubTree: SourceTreeReader;
  write: (rel: string, content: string) => void;
} {
  const repo = mkGitFixtureRepo(prefix);
  const write = (rel: string, content: string) => fs.writeFileSync(path.join(repo, rel), content);
  write(
    'packages/demo/src/entry.ts',
    'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n',
  );
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync(
    'git',
    ['-c', 'user.name=Gate', '-c', 'user.email=gate@example.test', 'commit', '-qm', 'hub'],
    { cwd: repo },
  );
  const hubTree = createCommittedSourceTree(repo, 'HEAD');
  // b and c move out verbatim; the hub keeps a and re-exports the parts.
  write(
    'packages/demo/src/entry.ts',
    "export const a = 1;\nexport * from './part-b.ts';\nexport * from './part-c.ts';\n",
  );
  write('packages/demo/src/part-b.ts', 'export const b = 2;\n');
  write('packages/demo/src/part-c.ts', 'export const c = 3;\n');
  return { repo, entry: path.join(repo, 'packages/demo/src/entry.ts'), hubTree, write };
}

function evidenceFromHub(entry: string, hubTree: SourceTreeReader): ClosureGrowthEvidence {
  const baseGraph = eagerClosureGraphOf(entry, hubTree);
  const headGraph = eagerClosureGraphOf(entry);
  return closureGrowthEvidence({
    baseGraph,
    headGraph,
    baseWeights: topLevelStatementWeightsOf(baseGraph.keys(), hubTree),
    headWeights: topLevelStatementWeightsOf(headGraph.keys()),
  });
}

test('planted pure split passes end to end: count grows, every base module survives, weight flat', () => {
  const { entry, hubTree } = mkSplitFixtureRepo('eager-closure-split-pure-');
  const evidence = evidenceFromHub(entry, hubTree);
  expect(evidence, 'one module became three: the count grows by two').toMatchObject({
    baseCount: 1,
    headCount: 3,
  });
  expect(
    evidence,
    'three declarations before, three after; the wiring lines are invisible',
  ).toMatchObject({ baseWeight: 3, headWeight: 3, preservedBaseClosure: true });
  expect(
    classifyGrowth('demo/entry', evidence),
    'the extraction ADR 0027 could not ship',
  ).toBeNull();
});

test('planted split smuggling a new heavy edge fails, naming the smuggled weight', () => {
  const { entry, hubTree, write } = mkSplitFixtureRepo('eager-closure-split-smuggled-');
  write(
    'packages/demo/src/part-c.ts',
    "import { scan } from './scanner.ts';\nexport const c = scan();\n",
  );
  write('packages/demo/src/scanner.ts', 'export function scan() {\n  return 4;\n}\n');
  const evidence = evidenceFromHub(entry, hubTree);
  expect(evidence.headWeight, 'scan() runs at module scope: that is eager work').toBe(4);
  expect(classifyGrowth('demo/entry', evidence)).toMatch(
    /adds 3 module\(s\) and 1 top-level statement\(s\)/,
  );
});

test('a renamed module inside the growth is not a dropped module', () => {
  const repo = mkGitFixtureRepo('eager-closure-split-rename-');
  const baseEntry = path.join(repo, 'packages/demo/src/entry.ts');
  const headEntry = path.join(repo, 'packages/demo/src/hub.ts');
  execFileSync('git', ['mv', 'packages/demo/src/entry.ts', 'packages/demo/src/hub.ts'], {
    cwd: repo,
  });
  const baseWeights = topLevelStatementWeightsOf(
    [baseEntry],
    createCommittedSourceTree(repo, 'HEAD'),
  );
  const headWeights = topLevelStatementWeightsOf([headEntry]);
  const shape = {
    baseGraph: new Map([[baseEntry, null]]),
    headGraph: new Map([[headEntry, null]]),
    baseWeights,
    headWeights,
  };
  expect(
    closureGrowthEvidence({
      ...shape,
      renamedBaseToHead: new Map([[baseEntry, headEntry]]),
    }).preservedBaseClosure,
    'the rename is the same module',
  ).toBe(true);
  expect(
    closureGrowthEvidence(shape).preservedBaseClosure,
    'without the rename map the same shape reads as a dropped module',
  ).toBe(false);
});

test('the weight counts module-scope work, not wiring or re-exporting', () => {
  // The whole tolerance rests on this number being invisible to re-homing wiring and sensitive to
  // module-scope execution. Both sides planted on one file each.
  expect(
    topLevelStatementCount(
      'hub.ts',
      "import { a } from './a.ts';\nexport * from './b.ts';\nexport const c = 3;\nexport function d() {}\n",
    ),
    'two wiring lines, two real statements',
  ).toBe(2);
  expect(
    topLevelStatementCount(
      'smuggle.ts',
      "import { scan } from './scanner.ts';\nexport const c = scan();\n",
    ),
    'the scan() call is module-scope work, only the import is wiring',
  ).toBe(1);
});

test('growth advice names both causes and both remedies, not one prescribed fix', () => {
  // #2423's review: a message that only ever says "move it behind a dynamic import" is wrong
  // advice when the growth is a new module that belongs in an existing one. This pins that the
  // verdict states both common causes and leaves the remedy to the reader.
  const finding =
    classifyGrowth('x.ts', {
      baseCount: 42,
      headCount: 43,
      baseWeight: 200,
      headWeight: 210,
      preservedBaseClosure: true,
    }) ?? '';
  expect(finding).toMatch(/new static edge/);
  expect(finding).toMatch(/used to load on demand/);
  expect(finding).toMatch(/home in a module the closure already evaluates/);
  expect(finding).toMatch(/function-scoped `await import`/);
});
