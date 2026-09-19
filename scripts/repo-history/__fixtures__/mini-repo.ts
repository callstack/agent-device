// A synthetic mini-repo history with every case the history model and the coupling formulas
// must get right, worked out by hand so the tests hard-assert exact numbers:
//
//   - a two-hop rename (alpha/b.ts -> alpha/b1.ts -> gamma/b2.ts) that crosses families;
//   - a one-hop rename inside a family (beta/z-old.ts -> beta/z.ts);
//   - a reused path (beta/w-old.ts added, renamed, added again, renamed elsewhere), which the
//     path-keyed rename map resolves through the LATER rename by declaration;
//   - a historical path that no longer exists (beta/old.ts, deleted in c10);
//   - a non-production path (README.md) and a merge commit with no records;
//   - a mass commit touching 61 production files, over the 60-file skip threshold.
//
// Kept edges at support >= 3: (a, b2) 3.5/4, (a, x) 2.5/3, (x, y) 2.5/3. See the tests for the
// per-family arithmetic that follows.

import type { PathRecord, RawCommit } from '../git-log.ts';

const A = 'packages/alpha/src/a.ts';
const B = 'packages/alpha/src/b.ts';
const B1 = 'packages/alpha/src/b1.ts';
const B2 = 'packages/gamma/src/b2.ts';
const X = 'src/beta/x.ts';
const Y = 'src/beta/y.ts';
const Z_OLD = 'src/beta/z-old.ts';
const Z = 'src/beta/z.ts';
const W_OLD = 'src/beta/w-old.ts';
const W = 'src/beta/w.ts';
const W2 = 'src/beta/w2.ts';
const OLD = 'src/beta/old.ts';

export const MASS_FILE_COUNT = 61;

export const MASS_FILES: readonly string[] = Array.from(
  { length: MASS_FILE_COUNT },
  (_, index) => `packages/mass/src/f${String(index + 1).padStart(3, '0')}.ts`,
);

export const MINI_REPO_PATHS = { A, B, B1, B2, X, Y, Z_OLD, Z, W_OLD, W, W2, OLD } as const;

export const MINI_REPO_FILES: readonly string[] = [A, B2, X, Y, Z, W, W2, ...MASS_FILES];

function add(path: string): PathRecord {
  return { status: 'A', path };
}
function modify(path: string): PathRecord {
  return { status: 'M', path };
}
function remove(path: string): PathRecord {
  return { status: 'D', path };
}
function rename(oldPath: string, path: string): PathRecord {
  return { status: 'R', path, oldPath };
}

function commit(
  sha: string,
  day: string,
  subject: string,
  records: readonly PathRecord[],
): RawCommit {
  return { sha, date: `${day}T12:00:00+00:00`, subject, records: [...records] };
}

export const MINI_REPO_COMMITS: readonly RawCommit[] = [
  commit('c01', '2026-01-05', 'feat(alpha): add the alpha and beta modules', [
    add(A),
    add(B),
    add(X),
    add(OLD),
    add('README.md'),
  ]),
  commit('c02', '2026-01-20', 'feat: add w', [add(W_OLD)]),
  commit('c03', '2026-01-25', 'refactor: rename w', [rename(W_OLD, W)]),
  commit('c04', '2026-01-28', 'feat: re-add w-old', [add(W_OLD)]),
  commit('c05', '2026-01-30', 'refactor: rename the second w-old', [rename(W_OLD, W2)]),
  commit('c06', '2026-02-01', 'refactor: rename b', [rename(B, B1), modify(A)]),
  commit('c07', '2026-03-01', 'refactor: move b1 to gamma', [rename(B1, B2), modify(A)]),
  commit('c08', '2026-03-15', 'feat(beta): add y', [add(Y), modify(X)]),
  commit('c09', '2026-04-01', 'fix: touch a and b2 again', [modify(A), modify(B2)]),
  commit('c10', '2026-04-10', 'chore: delete old', [remove(OLD)]),
  commit('c11', '2026-05-01', 'feat: add z', [add(Z_OLD), modify(X)]),
  commit('c12', '2026-06-01', 'refactor: rename z', [rename(Z_OLD, Z), modify(Y)]),
  commit('c13', '2026-07-01', 'fix: x and y', [modify(X), modify(Y)]),
  commit('c14', '2026-07-15', 'fix: x, y, z', [modify(X), modify(Y), modify(Z)]),
  commit('c15', '2026-08-01', 'chore: mass migration', MASS_FILES.map(modify)),
  commit('c16', '2026-08-15', "Merge branch 'topic'", []),
  commit('c17', '2026-09-01', 'fix(alpha): cross', [modify(A), modify(X)]),
  commit('c18', '2026-09-10', 'fix: a and x again', [modify(A), modify(X)]),
];

/** A `now` for trailing-window tests: 200 days back lands on 2026-03-03, between c07 and c08. */
export const MINI_REPO_NOW = new Date('2026-09-19T00:00:00Z');
