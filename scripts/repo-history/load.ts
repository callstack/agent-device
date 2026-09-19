// The one place the live history model is read off the repository, shared by the coupling and
// legibility reports so both describe the same commits and the same file set. The file set is
// the layering gate's own (`listSourceFiles`), never a second enumeration.

import { listSourceFiles } from '../layering/check.ts';
import { parseNameStatusLog, readNameStatusLog } from './git-log.ts';
import { buildRepoHistory, type RepoHistory } from './model.ts';

export type LiveRepoHistory = RepoHistory & { files: string[] };

export function loadRepoHistory(repoRoot: string): LiveRepoHistory {
  const files = listSourceFiles();
  const history = buildRepoHistory(parseNameStatusLog(readNameStatusLog(repoRoot)), new Set(files));
  return { ...history, files };
}
