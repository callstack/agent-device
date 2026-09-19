# Rename-resolved history model

```sh
pnpm repo-history:test
```

The single history model both module-shape reports consume (`scripts/coupling/`,
`scripts/legibility/`). It has no command of its own: the productive artifact is the model the
reports load through `load.ts`, and the point of one shared model is that both reports describe
the same commits, the same renames, and the same file set by construction.

## What it answers

For every current production file (the layering gate's own set, `listSourceFiles`) and every
commit in `git log -M --name-status`:

- `renames.ts` — an `oldPath -> newPath` map from every `R` record, and `resolve(path)` that
  applies it transitively (cycle-guarded, memoised) so a historical path reaches today's path.
- `records.ts` — the first-touch record: the first commit in `git log` order (newest first)
  whose rename-resolved record adds or renames the file. That is the commit that **placed** the
  file where it is today, so `status: 'R'` means "arrived here by rename" and its subject is the
  sentence written about that placement.
- `commits.ts` — per commit, the set of rename-resolved current production file ids. Deleted
  paths are not membership; a merge commit has an empty set.

## What the numbers do not mean

- The rename map is keyed by path alone, with no time axis. A path reused after a rename follows
  the **later** rename. On this tree that is a handful of files; the fixture pins the behaviour so
  it is a declared model, not a surprise.
- A record that resolves to a path no longer in the tree is dropped, not counted. The model says
  nothing about deleted code.
- Committer date is used throughout because a trailing window asks when a change **landed**;
  author dates on squash-merged branches can be days earlier.

## Reference values (2026-09-19, commit a556e114cd)

| | value |
| --- | --- |
| commits in history | 1,979 |
| commits touching a current production file | 1,333 |
| current production files with a first-touch record | 1,726 of 1,726 |
| files whose first touch is a rename (`status: 'R'`) | 827 |

## What is authoritative

`scripts/layering/` is, for the file set and the family partition. This module never enumerates
files itself; `load.ts` calls `listSourceFiles` and everything downstream keys on those ids. Git is
authoritative for history: `git-log.ts` owns the one log invocation and its parser, and
`git-log.test.ts` runs it against a real temporary repository with a two-hop rename so the format
contract cannot drift silently.

Tests hard-assert on the committed fixture in `__fixtures__/mini-repo.ts` (two-hop rename, reused
path, deleted path, mass commit), never on the live tree, except the `load.test.ts` smoke that
proves the live model resolves onto the live file set.
