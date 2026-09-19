import assert from 'node:assert/strict';
import { test } from 'node:test';
import { targetDagZone } from '../layering/model.ts';
import { MINI_REPO_COMMITS, MINI_REPO_FILES } from '../repo-history/__fixtures__/mini-repo.ts';
import { buildRepoHistory } from '../repo-history/model.ts';
import { familiesTouched, familySpan } from './span.ts';

const history = buildRepoHistory(MINI_REPO_COMMITS, new Set(MINI_REPO_FILES));

test('counts distinct families per commit', () => {
  const c01 = history.commits.find((commit) => commit.sha === 'c01')!;
  assert.equal(familiesTouched(c01, targetDagZone), 3);
  const c17 = history.commits.find((commit) => commit.sha === 'c17')!;
  assert.equal(familiesTouched(c17, targetDagZone), 2);
});

test('histogram, median over multi-family commits, and the >= 5 share skip mass commits', () => {
  const span = familySpan(history.commits, targetDagZone, 60);
  assert.deepEqual(span.histogram, { 1: 9, 2: 5, 3: 1 });
  assert.equal(span.usableCommits, 15);
  assert.equal(span.multiFamilyCommits, 6);
  assert.equal(span.median, 2);
  assert.equal(span.shareAtLeast5, 0);
  const withMass = familySpan(history.commits, targetDagZone, 61);
  assert.equal(withMass.usableCommits, 16);
  assert.deepEqual(withMass.histogram, { 1: 10, 2: 5, 3: 1 });
});

test('an even number of multi-family commits takes the middle mean, and no commits gives null', () => {
  const commits = [
    { sha: '1', date: '', subject: '', files: ['packages/a/src/x.ts', 'packages/b/src/y.ts'] },
    {
      sha: '2',
      date: '',
      subject: '',
      files: [
        'packages/a/src/x.ts',
        'packages/b/src/y.ts',
        'packages/c/src/z.ts',
        'packages/d/src/w.ts',
        'packages/e/src/v.ts',
      ],
    },
  ];
  const span = familySpan(commits, targetDagZone, 60);
  assert.equal(span.median, 3.5);
  assert.equal(span.shareAtLeast5, 0.5);
  const none = familySpan([], targetDagZone, 60);
  assert.deepEqual([none.median, none.shareAtLeast5, none.usableCommits], [null, null, 0]);
});
