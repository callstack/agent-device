// The census of shell CI runs outside the gate runner, as a generated baseline.
//
// This was 383 lines of hand-written entries, each carrying its own prose. That made the
// list the largest thing in the manifest and put a digest in a code review every time a
// step moved. The identities and digests are now generated into `baseline.json` and the
// prose lives once per declaring file (`REASONS`), which is the granularity anyone actually
// reads it at.
//
// The polarity is unchanged, and it is the only thing that matters here: a step missing
// from the baseline fails as a bypass, and a baseline entry matching no live step fails as
// inert. Regenerating is an explicit command whose diff a reviewer reads — `pnpm
// check:gate-manifest --update` — not something the audit does for itself.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REASONS } from './declarations.ts';
import type { Lane } from './workflows.ts';

export type BaselineEntry = {
  /** The file declaring the step: a workflow, or the composite action it came from. */
  readonly source: string;
  /** Human label only. The DIGEST is what is matched — a name is mutable metadata. */
  readonly step: string;
  readonly digest: string;
};

const FILE = path.join(import.meta.dirname, 'baseline.json');

export function loadBaseline(file = FILE): BaselineEntry[] {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as BaselineEntry[];
}

/** Why the steps in a given file run outside the runner, for a reviewer reading the diff. */
export function reasonFor(source: string): string {
  return REASONS[source]?.reason ?? '(no reason recorded — add one to REASONS)';
}

const key = (entry: BaselineEntry) => JSON.stringify([entry.source, entry.digest]);

/**
 * One fingerprint over everything a file contributes to the census.
 *
 * Arity alone was not enough, and round 11 said why: `--update` regenerates digests, so
 * REPLACING one non-gate body with another leaves the count identical and the audit green.
 * Confirmed on this branch — swapping a `linux.yml` step's body for
 * `node -e 'import("./scripts/layering/check.ts")'` kept 90 entries and printed `ok`.
 *
 * Hashing the file's digests means any add, delete or edit moves this one value, and it lives
 * in the hand-written declaration rather than the generated file. That is the "explicit owned
 * waiver" the review asked for three rounds running, expressed as 21 fingerprints instead of
 * 90 prose entries.
 */
export function fileDigest(entries: readonly BaselineEntry[], source: string): string {
  const digests = entries
    .filter((entry) => entry.source === source)
    .map((entry) => entry.digest)
    .sort();
  return createHash('sha256').update(digests.join('\n')).digest('hex').slice(0, 12);
}

/**
 * Every step a qualifying lane reaches that is not a plain gate invocation, deduplicated by
 * declaring file and digest, so a composite action used by eight lanes appears once.
 */
export function census(
  lanes: readonly Lane[],
  isPlainGate: (step: Lane['steps'][number]) => boolean,
): BaselineEntry[] {
  const found = new Map<string, BaselineEntry>();
  for (const lane of lanes.filter((entry) => entry.qualifying)) {
    for (const step of lane.steps) {
      if (isPlainGate(step)) continue;
      const entry = { source: step.source, step: step.name, digest: step.digest };
      if (!found.has(key(entry))) found.set(key(entry), entry);
    }
  }
  return [...found.values()].sort((a, b) =>
    a.source === b.source ? a.digest.localeCompare(b.digest) : a.source.localeCompare(b.source),
  );
}

/**
 * Written in the repo formatter's own JSON shape, so `--update` and `pnpm format` agree.
 * A one-line-per-entry form read better as a diff, but oxfmt rewrites it on the next run,
 * and a generator the formatter fights produces churn nobody can review.
 */
export function writeBaseline(entries: readonly BaselineEntry[], file = FILE): void {
  fs.writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
}
