/**
 * Daemon RPC wire-surface gate, released-baseline half (#1432).
 *
 * The unit lane (`test/wire-compat/wire-compat.test.ts`) proves the ledger
 * matches the source it describes. It cannot prove the thing ADR 0006 actually
 * requires — that a wire change since the last RELEASED version came with a
 * protocol bump — because from a single commit a bumped ledger and an unbumped
 * one are both just an edited file.
 *
 * So this reads the ledger as it stood at the last released tag and hands both
 * to `model.ts`. Baseline is the released tag, never arbitrary git history: an
 * unreleased shape has no peer in the wild to be incompatible with (AGENTS.md,
 * "Unreleased API surface dies free"), so mid-branch churn is free and only the
 * net change since publication has to be justified.
 *
 * Needs full history and tags, so it runs in its own fetch-depth: 0 CI job
 * rather than inside the shallow-clone-safe unit lane — the same split the
 * replay-compat corpus provenance verifier uses.
 */

import path from 'node:path';
import { repoGit, requireUnshallowHistory } from '../lib/repo-git.ts';
import { renamedSince } from '../__tests__/committed-source-tree.ts';
import { digestDeclaration } from '../../test/wire-compat/declaration-digest.ts';
import {
  digestWireSurface,
  parseWireLedger,
  readWireLedger,
  WIRE_LEDGER_PATH,
} from '../../test/wire-compat/ledger.ts';
import { WIRE_DECLARATIONS } from '../../test/wire-compat/surface.ts';
import { compareWireLedgers } from './model.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

const git = repoGit(repoRoot);
requireUnshallowHistory(git, 'Daemon wire compatibility');

/** Released tags newest-first by semver, not by tag-creation order. */
function releasedTagsNewestFirst(): string[] {
  return git(['tag', '--list', 'v*'])
    .split('\n')
    .map((tag) => ({ tag, version: /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag) }))
    .filter((entry) => entry.version !== null)
    .map((entry) => ({ tag: entry.tag, parts: entry.version!.slice(1, 4).map(Number) }))
    .sort(
      (a, b) => b.parts[0]! - a.parts[0]! || b.parts[1]! - a.parts[1]! || b.parts[2]! - a.parts[2]!,
    )
    .map((entry) => entry.tag);
}

const tags = releasedTagsNewestFirst();
if (tags.length === 0) {
  throw new Error('No release tags found. Run `git fetch --tags` first.');
}

/**
 * The newest release that carries a ledger. Releases cut before this gate
 * landed have none — those are skipped rather than read as an empty wire
 * surface, which would report every declaration as "added since release".
 */
const baseline = tags
  .map((tag) => ({ tag, raw: git(['show', `${tag}:${WIRE_LEDGER_PATH}`]) }))
  .find((entry) => entry.raw.length > 0);

if (!baseline) {
  process.stdout.write(
    `No released tag carries ${WIRE_LEDGER_PATH} yet (newest checked: ${tags[0]}). The ledger ` +
      `becomes enforceable against a released baseline at the next publish; until then the unit ` +
      `lane holds it to its source. Rule coverage meanwhile: scripts/wire-compat/model.test.ts.\n`,
  );
  process.exit(0);
}

/**
 * Rename pairs from the baseline tag to HEAD, as `<file> -> <file>`. The ledger's
 * move detection identifies a moved declaration by a sole same-name re-declaration;
 * a bulk `git mv` of two files that share a declaration name (the daemon's two
 * `sendJson` helpers) outruns that heuristic, because both destinations are claimed
 * by candidates. Git's rename detection knows the truth for the whole tree at once,
 * so the baseline's keys are canonicalized into HEAD coordinates before comparison.
 * Digests travel unchanged: a pure move is not a wire change.
 */
function tagToHeadRenames(tag: string): Map<string, string> {
  // head -> base at [tag, HEAD]; flipped into the base -> head direction the ledger needs.
  const flipped = new Map<string, string>();
  for (const [headPath, basePath] of renamedSince(repoRoot, tag, 'HEAD'))
    flipped.set(basePath, headPath);
  return flipped;
}

function canonicalizeLedgerRef(ref: string, renames: ReadonlyMap<string, string>): string {
  const hash = ref.lastIndexOf('#');
  const renamed = renames.get(ref.slice(0, hash));
  return renamed === undefined ? ref : `${renamed}#${ref.slice(hash + 1)}`;
}

const releasedRenames = tagToHeadRenames(baseline.tag);
const released = parseWireLedger(baseline.raw, `${baseline.tag}:${WIRE_LEDGER_PATH}`);
const result = compareWireLedgers({
  baselineTag: baseline.tag,
  released: {
    ...released,
    declarations: Object.fromEntries(
      Object.entries(released.declarations).map(([ref, digest]) => [
        canonicalizeLedgerRef(ref, releasedRenames),
        digest,
      ]),
    ),
    compatibleChanges: released.compatibleChanges.map((change) => ({
      ...change,
      declaration: canonicalizeLedgerRef(change.declaration, releasedRenames),
    })),
  },
  current: readWireLedger(repoRoot),
  digests: digestWireSurface(repoRoot, WIRE_DECLARATIONS, digestDeclaration),
});

if (result.failures.length > 0) {
  throw new Error(
    `Daemon RPC wire compatibility (#1432, ADR 0006):\n${result.failures.join('\n')}`,
  );
}

process.stdout.write(
  `Daemon RPC wire surface checked against ${baseline.tag} ` +
    `(protocol ${result.bumped ? 'bumped' : 'unchanged'}): ${WIRE_DECLARATIONS.length} ` +
    `declarations, ${result.changed.length} changed, ${result.removed.length} removed, ` +
    `${result.added.length} added, ${result.moved.length} moved.\n`,
);
