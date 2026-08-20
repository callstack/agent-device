export type CoverageClassificationLevel =
  | 'live'
  | 'command-contract'
  | 'capability-denial'
  | 'known-gap';

export type CoverageClassificationSummary = {
  capabilityDenial: number;
  contract: number;
  gap: number;
  live: number;
  total: number;
};

export function buildCoverageClassificationSummary(
  entries: readonly { level: CoverageClassificationLevel }[],
): CoverageClassificationSummary {
  const summary: CoverageClassificationSummary = {
    capabilityDenial: 0,
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
      case 'capability-denial':
        summary.capabilityDenial += 1;
        break;
      case 'known-gap':
        summary.gap += 1;
        break;
    }
  }
  return summary;
}
