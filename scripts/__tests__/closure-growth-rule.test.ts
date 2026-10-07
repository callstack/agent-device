import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  eagerClosureGraphOf,
  statementTextsOf,
  topLevelStatementCount,
  topLevelStatementWeightsOf,
  type SourceTreeReader,
} from '../../src/__tests__/eager-import-closure.fixtures.ts';
import { createCommittedSourceTree, deletedSourcesSince } from './committed-source-tree.ts';
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
 * direction the three facts (containment, added-module novelty, flat weight) guard gets its own
 * planted repo here: a pure split that must pass, a split smuggling a new heavy edge that must
 * fail, a split pulling in a PRE-EXISTING closure-external module at weight offset by hub
 * shrinkage that must fail, a swap that drops a merge-base module that must fail at flat
 * weight, and a rename that must not read as a drop or as a new module.
 */

test('no-growth fails growth with both counts and passes an equal or smaller closure', () => {
  const at = (over: Partial<ClosureGrowthEvidence> = {}) => ({
    baseCount: 42,
    headCount: 42,
    baseWeight: 200,
    headWeight: 200,
    preservedBaseClosure: true,
    addedModulesAreNew: true,
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
// The tolerance is exactly three facts: the head still evaluates EVERY merge-base module, every
// newly evaluated module is new to the tree, and the closure's total top-level-statement weight
// did not grow. Every failing direction is planted.

test('a pure split passes: every base module survives, added modules are new, weight flat', () => {
  // entry -> hub(8 statements) becomes entry -> hub(wiring only) -> part-a + part-b carrying the
  // declarations: count 2 -> 4, weight unchanged.
  const at = (over: Partial<ClosureGrowthEvidence> = {}) => ({
    baseCount: 2,
    headCount: 4,
    baseWeight: 10,
    headWeight: 10,
    preservedBaseClosure: true,
    addedModulesAreNew: true,
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
    addedModulesAreNew: true,
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
    addedModulesAreNew: true,
  });
  expect(finding).toMatch(/evaluates 4 modules.*merge-base evaluated 2/);
  expect(finding).toMatch(/not a split of existing code/);
});

test('a pre-existing module newly made eager fails at flat weight: shrinkage cannot fund it', () => {
  // The maintainer-review hole: containment holds and weight is flat only because the PR
  // deleted statements elsewhere in the closure; the added module sat in the merge-base tree
  // outside the closure, so it is a new eager edge, not re-homed code.
  const finding = classifyGrowth('x.ts', {
    baseCount: 2,
    headCount: 4,
    baseWeight: 10,
    headWeight: 10,
    preservedBaseClosure: true,
    addedModulesAreNew: false,
  });
  expect(finding).toMatch(/evaluates 4 modules.*merge-base evaluated 2/);
  expect(finding).toMatch(/newly evaluates code the merge-base tree already had/);
  expect(finding).toMatch(/shrinkage elsewhere cannot fund a new eager edge/);
});

/**
 * A hub repo at two states: the hub commit carrying three declarations plus any committed
 * extras (files that EXIST in the base tree but sit outside the entry's closure), then the
 * working tree holding the pure split of two of them into parts. The smuggle tests mutate this
 * state BEFORE their first working-tree walk, because the walker memoizes edges per path -- one
 * walk per repo.
 */
function mkSplitFixtureRepo(
  prefix: string,
  committedExtras: Record<string, string> = {},
): {
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
  for (const [rel, content] of Object.entries(committedExtras)) write(rel, content);
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

function evidenceFromHub(
  entry: string,
  hubTree: SourceTreeReader,
  repo: string,
  baseRef = 'HEAD',
): ClosureGrowthEvidence {
  const baseGraph = eagerClosureGraphOf(entry, hubTree);
  const headGraph = eagerClosureGraphOf(entry);
  return closureGrowthEvidence({
    baseGraph,
    headGraph,
    baseWeights: topLevelStatementWeightsOf(baseGraph.keys(), hubTree),
    headWeights: topLevelStatementWeightsOf(headGraph.keys()),
    headStatementTexts: statementTextsOf(headGraph.keys()),
    baseTree: hubTree,
    deletedSourceTexts: [
      ...statementTextsOf(
        deletedSourcesSince(repo, baseRef).map((file) => path.join(repo, file)),
        hubTree,
      ).values(),
    ],
  });
}

test('planted pure split passes end to end: count grows, every base module survives, weight flat', () => {
  const { entry, hubTree, repo } = mkSplitFixtureRepo('eager-closure-split-pure-');
  const evidence = evidenceFromHub(entry, hubTree, repo);
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
  const { entry, hubTree, write, repo } = mkSplitFixtureRepo('eager-closure-split-smuggled-');
  write(
    'packages/demo/src/part-c.ts',
    "import { scan } from './scanner.ts';\nexport const c = scan();\n",
  );
  write('packages/demo/src/scanner.ts', 'export function scan() {\n  return 4;\n}\n');
  const evidence = evidenceFromHub(entry, hubTree, repo);
  expect(evidence.headWeight, 'scan() runs at module scope: that is eager work').toBe(4);
  expect(classifyGrowth('demo/entry', evidence)).toMatch(
    /adds 3 module\(s\) and 1 top-level statement\(s\)/,
  );
});

test('planted split pulling in a PRE-EXISTING closure-external module fails at offset weight', () => {
  // The maintainer-review hole: `pre-existing-heavy.ts` is committed at the hub commit but no
  // file imports it, so it sits in the merge-base tree OUTSIDE the closure. The split's part-c
  // side-effect-imports it, and the weight is offset by merging b and c into one declaration --
  // containment holds and weight is flat, so a two-fact rule passes it. The added module is not
  // new to the tree, so the novelty fact fails and the verdict names shrinkage-funding.
  const { entry, hubTree, write, repo } = mkSplitFixtureRepo('eager-closure-split-pre-existing-', {
    'packages/demo/src/pre-existing-heavy.ts': 'export const heavy = 42;\n',
  });
  write('packages/demo/src/part-b.ts', 'export const bc = { b: 2, c: 3 };\n');
  write('packages/demo/src/part-c.ts', "import './pre-existing-heavy.ts';\n");
  const evidence = evidenceFromHub(entry, hubTree, repo);
  expect(
    evidence,
    'the two facts this shape defeats both hold: 1+1+0+1 weight against 3, containment intact',
  ).toMatchObject({
    baseWeight: 3,
    headWeight: 3,
    preservedBaseClosure: true,
    addedModulesAreNew: false,
  });
  const finding = classifyGrowth('demo/entry', evidence);
  expect(finding, 'the third fact is the one that refuses it').toMatch(
    /newly evaluates code the merge-base tree already had/,
  );
});

test('a moved-in pre-existing module survives only as a detected rename', () => {
  // The rename-canonicalization scope, pinned: canonicalization preserves modules ALREADY IN
  // the base closure. Here `facades/top.ts` sat outside the entry's closure at the merge-base;
  // the PR renames it (a `git mv` so `-M` pairs it) under a new name and imports it. At the
  // HEAD path it is new to the tree, so a head-path check would pass it; checking the
  // canonicalized BASE path -- where the merge-base necessarily has it -- reads it as what it
  // is: pre-existing code newly made eager.
  const repo = mkGitFixtureRepo('eager-closure-split-move-in-');
  fs.writeFileSync(
    path.join(repo, 'packages/demo/src/entry.ts'),
    "import { b } from './facades/nested/moved.ts';\nexport { b };\n",
  );
  execFileSync(
    'git',
    ['mv', 'packages/demo/src/facades/top.ts', 'packages/demo/src/facades/nested/moved.ts'],
    {
      cwd: repo,
    },
  );
  const baseTree = createCommittedSourceTree(repo, 'HEAD');
  const entry = path.join(repo, 'packages/demo/src/entry.ts');
  const evidence = closureGrowthEvidence({
    baseGraph: eagerClosureGraphOf(entry, baseTree),
    headGraph: eagerClosureGraphOf(entry),
    baseWeights: topLevelStatementWeightsOf(eagerClosureGraphOf(entry, baseTree).keys(), baseTree),
    headWeights: topLevelStatementWeightsOf(eagerClosureGraphOf(entry).keys()),
    headStatementTexts: statementTextsOf(eagerClosureGraphOf(entry).keys()),
    baseTree,
    renamedBaseToHead: new Map([
      [
        path.join(repo, 'packages/demo/src/facades/top.ts'),
        path.join(repo, 'packages/demo/src/facades/nested/moved.ts'),
      ],
    ]),
  });
  expect(
    evidence,
    'count 1 -> 2 at flat weight: path-level novelty is what refuses it',
  ).toMatchObject({
    baseWeight: 1,
    headWeight: 1,
    preservedBaseClosure: true,
    addedModulesAreNew: false,
  });
});

test('planted rewritten move of a pre-existing heavy module fails at offset weight, beyond -M', () => {
  // The Cubic follow-up: a PR deletes `heavy.ts` (committed, closure-external), rewrites it into
  // a much smaller `moved-heavy.ts` under a new path -- similar enough to still carry real code,
  // different enough that git's `-M` reports D + A rather than R -- imports it from the split's
  // part-c, and pays for the carried statements by flattening the hub's own declarations. Path
  // novelty alone reads moved-heavy.ts as brand new; the deleted-source content comparison is
  // what refuses it.
  const repo = mkGitFixtureRepo('eager-closure-split-rewritten-move-');
  const write = (rel: string, content: string) => fs.writeFileSync(path.join(repo, rel), content);
  write(
    'packages/demo/src/entry.ts',
    'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n',
  );
  write(
    'packages/demo/src/heavy.ts',
    [
      'const tableA = { alpha: 1, beta: 2 };',
      'const tableB = { gamma: 3, delta: 4 };',
      'const tableC = { epsilon: 5, zeta: 6 };',
      'function padOne() {',
      '  return tableA.alpha;',
      '}',
      'function padTwo() {',
      '  return tableB.gamma;',
      '}',
      'function padThree() {',
      '  return tableC.epsilon;',
      '}',
      'function padFour() {',
      '  return tableA.beta + tableB.delta;',
      '}',
      'function padFive() {',
      '  return tableC.zeta;',
      '}',
      'export function lookupA(key: string) {',
      '  return tableA[key];',
      '}',
      'export function lookupB(key: string) {',
      '  return tableB[key];',
      '}',
      'export function lookupC(key: string) {',
      '  return tableC[key];',
      '}',
      '',
    ].join('\n'),
  );
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync(
    'git',
    ['-c', 'user.name=Gate', '-c', 'user.email=gate@example.test', 'commit', '-qm', 'hub'],
    { cwd: repo },
  );
  const hubTree = createCommittedSourceTree(repo, 'HEAD');
  // The rewritten move: only two statements survive, one with layout churn and one with a
  // re-export, so `-M` calls it delete + new file.
  fs.rmSync(path.join(repo, 'packages/demo/src/heavy.ts'));
  write(
    'packages/demo/src/moved-heavy.ts',
    '// relocated from heavy.ts during the split\n\n\nconst tableA = {   alpha: 1,   beta: 2 };\n\n\n/** the surviving lookup */\nexport function lookupA(key: string) {\n\n\n  return tableA[key];\n}\n',
  );
  // Hub flattened to wiring; b and c merged into one declaration: the offset payment.
  write(
    'packages/demo/src/entry.ts',
    "export * from './part-b.ts';\nexport * from './part-c.ts';\n",
  );
  write('packages/demo/src/part-b.ts', 'export const bc = { b: 2, c: 3 };\n');
  write('packages/demo/src/part-c.ts', "import './moved-heavy.ts';\n");
  const renameStatus = execFileSync('git', ['diff', '--name-status', '-M', 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
  });
  expect(
    renameStatus,
    'the planted evasion must hold: -M must NOT pair the move, or this tests rename handling',
  ).toMatch(/^D\tpackages\/demo\/src\/heavy\.ts$/m);
  const entry = path.join(repo, 'packages/demo/src/entry.ts');
  const evidence = evidenceFromHub(entry, hubTree, repo);
  expect(
    evidence,
    'count 1 -> 4 at flat weight 3 -> 3 with containment intact: only content provenance refuses it',
  ).toMatchObject({
    baseWeight: 3,
    headWeight: 3,
    preservedBaseClosure: true,
    addedModulesAreNew: false,
  });
  const finding = classifyGrowth('demo/entry', evidence);
  expect(finding).toMatch(/newly evaluates code the merge-base tree already had/);
});

test('a renamed module inside the growth is not a dropped module', () => {
  const repo = mkGitFixtureRepo('eager-closure-split-rename-');
  const baseEntry = path.join(repo, 'packages/demo/src/entry.ts');
  const headEntry = path.join(repo, 'packages/demo/src/hub.ts');
  execFileSync('git', ['mv', 'packages/demo/src/entry.ts', 'packages/demo/src/hub.ts'], {
    cwd: repo,
  });
  const baseTree = createCommittedSourceTree(repo, 'HEAD');
  const baseWeights = topLevelStatementWeightsOf([baseEntry], baseTree);
  const headWeights = topLevelStatementWeightsOf([headEntry]);
  const shape = {
    baseGraph: new Map([[baseEntry, null]]),
    headGraph: new Map([[headEntry, null]]),
    baseWeights,
    headWeights,
    headStatementTexts: statementTextsOf([headEntry]),
    baseTree,
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
  // Novelty canonicalization: when the head path of a rename PRE-EXisted in the base tree (a
  // rename landing on a path that sat outside the closure), only the rename map can tell the
  // rename's head from a pre-existing module newly made eager.
  const collidingTree = { exists: (file: string) => file === headEntry };
  expect(
    closureGrowthEvidence({
      ...shape,
      baseTree: collidingTree,
      renamedBaseToHead: new Map([[baseEntry, headEntry]]),
    }).addedModulesAreNew,
    'the rename map says the pre-existing head path is the same module, not new eager code',
  ).toBe(true);
  expect(
    closureGrowthEvidence({ ...shape, baseTree: collidingTree }).addedModulesAreNew,
    'without the map the same path reads as a pre-existing module newly made eager',
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
  expect(
    topLevelStatementCount(
      're-export.ts',
      "import { a } from './a.ts';\nexport { a };\nexport const b = 2;\n",
    ),
    'a source-less `export { a }` re-names a local binding: the other wiring half of a split',
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
      addedModulesAreNew: true,
    }) ?? '';
  expect(finding).toMatch(/new static edge/);
  expect(finding).toMatch(/used to load on demand/);
  expect(finding).toMatch(/home in a module the closure already evaluates/);
  expect(finding).toMatch(/function-scoped `await import`/);
});
