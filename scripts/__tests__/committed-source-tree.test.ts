import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { eagerClosureGraphOf } from '@agent-device/test-kit';
import { createCommittedSourceTree, renamedSince } from './committed-source-tree.ts';
import { mkGitFixtureRepo } from './eager-closure-gate-fixtures.ts';

test('a PR merge retains branch rename history and measures the merged tree', () => {
  const repo = mkGitFixtureRepo('renamed-since-pr-merge-');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo }).toString().trim();
  const original = 'packages/demo/src/entry.ts';
  const moved = 'packages/demo/src/moved.ts';
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'pr');
  git('mv', original, moved);
  git('commit', '-qm', 'move');
  fs.appendFileSync(
    path.join(repo, moved),
    "export * from './main.ts';\n" + '// documentation\n'.repeat(100),
  );
  git('commit', '-aqm', 'document');
  const pr = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'advanced-main', base);
  fs.writeFileSync(path.join(repo, 'packages/demo/src/main.ts'), 'export const main = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'advance main');
  const main = git('rev-parse', 'HEAD');
  git('merge', '--no-ff', '-qm', 'merge PR', pr);
  const merge = git('rev-parse', 'HEAD');
  expect(git('rev-parse', 'HEAD^1')).toBe(main);
  expect(git('rev-parse', 'HEAD^2')).toBe(pr);
  expect(renamedSince(repo, main, merge).get(moved)).toBe(renamedSince(repo, base, pr).get(moved));
  expect(renamedSince(repo, main, merge).get(moved)).toBe(original);
  expect(
    createCommittedSourceTree(repo, merge).isFile(path.join(repo, 'packages/demo/src/main.ts')),
  ).toBe(true);
  expect(
    eagerClosureGraphOf(path.join(repo, moved), createCommittedSourceTree(repo, pr)).size,
  ).toBe(1);
  expect(
    eagerClosureGraphOf(path.join(repo, moved), createCommittedSourceTree(repo, merge)).size,
  ).toBe(2);
  git('checkout', '-qb', 'deleted-in-merge', main);
  git('merge', '--no-ff', '--no-commit', pr);
  git('rm', '-f', moved);
  git('commit', '-qm', 'merge without entry');
  expect(renamedSince(repo, main, 'HEAD').has(moved)).toBe(false);
  git('checkout', '-q', 'advanced-main');
  git('rm', moved);
  git('commit', '-qm', 'delete moved entry');
  fs.writeFileSync(path.join(repo, moved), 'export const replacement = true;\n');
  git('add', moved);
  git('commit', '-qm', 'replace entry');
  expect(renamedSince(repo, main, 'HEAD').has(moved)).toBe(false);
});

test('a merge does not claim an origin replaced on its first parent', () => {
  const repo = mkGitFixtureRepo('renamed-since-pr-replaced-base-');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo }).toString().trim();
  const original = 'packages/demo/src/entry.ts';
  const moved = 'packages/demo/src/moved.ts';
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'pr');
  git('mv', original, moved);
  git('commit', '-qm', 'move');
  fs.appendFileSync(path.join(repo, moved), '// documentation\n'.repeat(100));
  git('commit', '-aqm', 'document');
  const pr = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'advanced-main', base);
  fs.writeFileSync(path.join(repo, original), 'export const replacement = true;\n');
  git('commit', '-aqm', 'replace original');
  const main = git('rev-parse', 'HEAD');
  try {
    git('merge', '--no-ff', '--no-commit', pr);
  } catch {
    git('rm', original);
  }
  git('commit', '-qm', 'merge PR');
  expect(renamedSince(repo, main, 'HEAD').has(moved)).toBe(false);
  expect(renamedSince(repo, pr, 'HEAD').has(moved)).toBe(false);
});
