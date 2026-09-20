import assert from 'node:assert/strict';

export type CoverageClassificationLevel = 'live' | 'command-contract' | 'known-gap';

export type CoverageClassificationSummary = {
  contract: number;
  gap: number;
  live: number;
  total: number;
};

type CoverageBucket = 'live' | 'contract' | 'gap';

const BUCKET_BY_LEVEL: Readonly<Record<CoverageClassificationLevel, CoverageBucket>> = {
  live: 'live',
  'command-contract': 'contract',
  'known-gap': 'gap',
};

/**
 * Proves a published summary is still the rollup of the manifest it is exported beside, and that the
 * manifest still covers the public catalog. It catches a summary wired to the wrong array, a
 * mis-bucketed rollup, and a denominator that stopped matching the catalog.
 *
 * What it cannot catch is a row classified under the wrong `level`: the recount and the published
 * summary read the same rows, so a row moved between buckets moves both and stays consistent. That
 * membership is gated by {@link assertLiveCoverageMatchesEvidence}, or by the equivalent enumeration
 * a platform already reads — Linux parses its replay script, Android reads each scenario's own
 * command declaration.
 */
export function assertCoverageClassificationSummaryWiredToManifest(
  platform: string,
  manifest: Readonly<Record<string, { level: CoverageClassificationLevel }>>,
  summary: CoverageClassificationSummary,
  publicCommands: readonly string[],
): void {
  const entries = Object.values(manifest);
  const recounted: CoverageClassificationSummary = {
    contract: 0,
    gap: 0,
    live: 0,
    total: entries.length,
  };
  for (const entry of entries) {
    recounted[BUCKET_BY_LEVEL[entry.level]] += 1;
  }
  assert.deepEqual(summary, recounted, `${platform} coverage summary is not its manifest's rollup`);
  assert.equal(
    summary.total,
    publicCommands.length,
    `${platform} coverage summary counts ${summary.total} commands, the public catalog has ${publicCommands.length}`,
  );
  assert.equal(
    summary.live + summary.contract + summary.gap,
    summary.total,
    `${platform} coverage summary buckets do not sum to its total`,
  );
}

/**
 * Ties a platform's live bucket to an enumeration of the commands its own evidence executes, read
 * from the scenario sources rather than from the manifest's `level` fields. Both directions matter:
 * an executed command that is not claimed live means the platform is understating what it proves,
 * and a live claim no scenario executes any more means the platform is overstating it. A platform
 * with no independent enumeration behind a bucket can only assert the rollup above.
 */
export function assertLiveCoverageMatchesEvidence(
  platform: string,
  manifest: Readonly<Record<string, { level: CoverageClassificationLevel }>>,
  evidenceCommands: Iterable<string>,
): void {
  const live = Object.entries(manifest)
    .filter(([, entry]) => entry.level === 'live')
    .map(([command]) => command)
    .sort();
  assert.deepEqual(
    [...new Set(evidenceCommands)].sort(),
    live,
    `${platform} live claims are not the commands its own evidence executes`,
  );
}

export function buildCoverageClassificationSummary(
  entries: readonly { level: CoverageClassificationLevel }[],
): CoverageClassificationSummary {
  const summary: CoverageClassificationSummary = {
    contract: 0,
    gap: 0,
    live: 0,
    total: entries.length,
  };
  for (const entry of entries) {
    switch (entry.level) {
      case 'live':
        summary.live += 1;
        break;
      case 'command-contract':
        summary.contract += 1;
        break;
      case 'known-gap':
        summary.gap += 1;
        break;
    }
  }
  return summary;
}
