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
 * Proves a published summary is the manifest's own rollup rather than a table kept aligned by
 * hand. The recount here is deliberately independent of {@link buildCoverageClassificationSummary},
 * and the denominator is the public command catalog, which the manifest's key set is asserted
 * against separately. A platform that wires its summary to the wrong array, or a manifest that
 * drops a command, fails on the line that owns the mistake.
 */
export function assertCoverageClassificationSummaryDerivedFromManifest(
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
