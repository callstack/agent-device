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
 * summary read the same rows, so a row moved between buckets moves both and stays consistent. Row
 * membership is gated where an independent enumeration of it exists — the Linux lane compares its
 * live set against the parsed replay script, the Android lane against each scenario's own command
 * declaration, the web lane against the commands its smoke scenario invokes. A platform whose live
 * claims have no enumeration behind them, macOS, is gated one way only: each claim must be executed
 * by the scenario that owns it, and adding a live claim therefore needs evidence.
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
