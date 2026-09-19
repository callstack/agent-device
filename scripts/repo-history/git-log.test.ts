import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NAME_STATUS_LOG_ARGS, parseNameStatusLog, readNameStatusLog } from './git-log.ts';

const SEP = String.fromCharCode(1);
const NUL = String.fromCharCode(0);

test('parses adds, modifies, deletes, renames, and record-less merge commits in order', () => {
  const text =
    `${SEP}aaa${NUL}2026-01-01T00:00:00+00:00${NUL}feat: first\n\n` +
    'A\tsrc/a.ts\nM\tREADME.md\n' +
    `${SEP}bbb${NUL}2026-01-02T00:00:00+00:00${NUL}refactor: move\n\n` +
    'R087\tsrc/a.ts\tsrc/b.ts\nD\tsrc/c.ts\nT\tsrc/d.ts\n' +
    `${SEP}ccc${NUL}2026-01-03T00:00:00+00:00${NUL}Merge branch 'x'\n`;
  assert.deepEqual(parseNameStatusLog(text), [
    {
      sha: 'aaa',
      date: '2026-01-01T00:00:00+00:00',
      subject: 'feat: first',
      records: [
        { status: 'A', path: 'src/a.ts' },
        { status: 'M', path: 'README.md' },
      ],
    },
    {
      sha: 'bbb',
      date: '2026-01-02T00:00:00+00:00',
      subject: 'refactor: move',
      records: [
        { status: 'R', path: 'src/b.ts', oldPath: 'src/a.ts' },
        { status: 'D', path: 'src/c.ts' },
        { status: 'T', path: 'src/d.ts' },
      ],
    },
    { sha: 'ccc', date: '2026-01-03T00:00:00+00:00', subject: "Merge branch 'x'", records: [] },
  ]);
});

test('keeps a subject that contains the field separator and drops malformed record lines', () => {
  const text = `${SEP}abc${NUL}2026-01-01T00:00:00+00:00${NUL}odd${NUL}subject\n\nQ\nA\t\n`;
  assert.deepEqual(parseNameStatusLog(text), [
    { sha: 'abc', date: '2026-01-01T00:00:00+00:00', subject: `odd${NUL}subject`, records: [] },
  ]);
});

test('reads a real repository oldest-first with rename detection on', () => {
  const root = mkdtempSync(join(tmpdir(), 'repo-history-git-log-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    });
  try {
    git('init', '-q', '-b', 'main');
    mkdirSync(join(root, 'src/one'), { recursive: true });
    const body = Array.from({ length: 40 }, (_, i) => `export const line${i} = ${i};`).join('\n');
    writeFileSync(join(root, 'src/one/first.ts'), `${body}\n`);
    git('add', '.');
    git('commit', '-q', '-m', 'feat: first');
    renameSync(join(root, 'src/one/first.ts'), join(root, 'src/one/second.ts'));
    git('add', '-A');
    git('commit', '-q', '-m', 'refactor: hop one');
    mkdirSync(join(root, 'src/two'), { recursive: true });
    renameSync(join(root, 'src/one/second.ts'), join(root, 'src/two/third.ts'));
    git('add', '-A');
    git('commit', '-q', '-m', 'refactor: hop two');

    const commits = parseNameStatusLog(readNameStatusLog(root));
    assert.equal(NAME_STATUS_LOG_ARGS.includes('--reverse'), true);
    assert.deepEqual(
      commits.map((commit) => commit.subject),
      ['feat: first', 'refactor: hop one', 'refactor: hop two'],
    );
    assert.deepEqual(commits[0]!.records, [{ status: 'A', path: 'src/one/first.ts' }]);
    assert.deepEqual(commits[1]!.records, [
      { status: 'R', path: 'src/one/second.ts', oldPath: 'src/one/first.ts' },
    ]);
    assert.deepEqual(commits[2]!.records, [
      { status: 'R', path: 'src/two/third.ts', oldPath: 'src/one/second.ts' },
    ]);
    assert.match(commits[0]!.date, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
