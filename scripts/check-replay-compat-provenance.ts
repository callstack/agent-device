/**
 * Re-derives the frozen replay-compat corpus (#1417) from git history: every
 * mined entry must still be the exact blob a RELEASED tag published at the path
 * it claims, and every tag the corpus cites must be a tag that was actually cut.
 *
 * The unit gate (`test/replay-compat/corpus.test.ts`) hashes the checked-in
 * bytes against the same object ids, which catches a rewritten script; only this
 * check can say those object ids came from a release rather than from whoever
 * wrote the manifest line.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  REPLAY_COMPAT_CORPUS,
  REPLAY_COMPAT_RELEASED_TAGS,
} from '../test/replay-compat/manifest.ts';
import { findProvenanceKindViolations } from '../test/replay-compat/provenance-rules.ts';
import { runCmdSync } from '../src/utils/exec.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const corpusRoot = path.join(repoRoot, 'test', 'replay-compat');

function git(args: string[]): string {
  return runCmdSync('git', args, { cwd: repoRoot, allowFailure: true }).stdout.trim();
}

if (git(['rev-parse', '--is-shallow-repository']) === 'true') {
  throw new Error(
    'Corpus provenance needs full history and tags. Run `git fetch --unshallow --tags` first.',
  );
}

// An entry that escaped `mined` would also escape the history check below, so
// the area rule is enforced here as well as in the unit lane.
const failures: string[] = [...findProvenanceKindViolations(REPLAY_COMPAT_CORPUS)];

const existingTags = new Set(git(['tag', '--list']).split('\n').filter(Boolean));
if (existingTags.size === 0) {
  throw new Error('No release tags found. Run `git fetch --tags` first.');
}
for (const tag of REPLAY_COMPAT_RELEASED_TAGS) {
  if (!existingTags.has(tag)) {
    failures.push(`${tag} is cited as a released version but is not a tag in this repository`);
  }
}

for (const entry of REPLAY_COMPAT_CORPUS) {
  if (!REPLAY_COMPAT_RELEASED_TAGS.includes(entry.recordedBy)) {
    failures.push(`${entry.id}: recordedBy ${entry.recordedBy} is not in REPLAY_COMPAT_RELEASED_TAGS`);
    continue;
  }
  if (entry.provenance.kind !== 'mined') continue;

  const { path: sourcePath, blob } = entry.provenance;
  const historical = git(['rev-parse', `${entry.recordedBy}:${sourcePath}`]);
  if (historical !== blob) {
    failures.push(
      `${entry.id}: ${entry.recordedBy}:${sourcePath} is ${historical || '<missing>'}, manifest pins ${blob}`,
    );
    continue;
  }
  const frozen = fs.readFileSync(path.join(corpusRoot, entry.file));
  const released = runCmdSync('git', ['cat-file', 'blob', blob], {
    cwd: repoRoot,
    binaryStdout: true,
  }).stdoutBuffer;
  if (!released?.equals(frozen)) {
    failures.push(`${entry.id}: ${entry.file} no longer matches the released blob ${blob}`);
  }
}

if (failures.length > 0) {
  throw new Error(
    `Replay-compat corpus provenance is broken (see test/replay-compat/README.md):\n${failures
      .map((failure) => `- ${failure}`)
      .join('\n')}`,
  );
}

const mined = REPLAY_COMPAT_CORPUS.filter((entry) => entry.provenance.kind === 'mined').length;
process.stdout.write(
  `Verified ${mined} mined replay-compat scripts against their released blobs across ${REPLAY_COMPAT_RELEASED_TAGS.length} tags (${REPLAY_COMPAT_CORPUS.length - mined} derived entries are digest-pinned).\n`,
);
