import { projectCoverage } from '../command-coverage/declarations.ts';
import type { PublicCommand } from '../command-coverage/entries.ts';
import { buildCoverageClassificationSummary } from '../support/coverage-classification.ts';

export { MACOS_COVERAGE_GAP_ISSUE } from '../command-coverage/evidence.ts';
export { MACOS_LIVE_SCENARIOS } from './live-scenarios.ts';

/**
 * One primary, observable owner for every public command on the local macOS host.
 *
 * Projected from the command-owned declaration table; the rows are authored there.
 */
export const MACOS_PLATFORM_COVERAGE = projectCoverage('macos');

export const MACOS_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY = buildCoverageClassificationSummary(
  Object.values(MACOS_PLATFORM_COVERAGE),
);

export function liveCommandsForScenario(scenarioId: string): PublicCommand[] {
  return Object.entries(MACOS_PLATFORM_COVERAGE)
    .filter(([, entry]) => entry.level === 'live' && entry.scenario === scenarioId)
    .map(([command]) => command as PublicCommand);
}
