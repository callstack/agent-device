import { projectCoverage } from '../command-coverage/declarations.ts';
import type { PublicCommand } from '../command-coverage/entries.ts';
import { buildCoverageClassificationSummary } from '../support/coverage-classification.ts';

/**
 * One primary, observable owner for every public command on an Android emulator.
 *
 * Projected from the command-owned declaration table; the rows are authored there.
 */
export const ANDROID_EMULATOR_E2E_COVERAGE = projectCoverage('androidEmulator');

export const ANDROID_EMULATOR_COVERAGE_CLASSIFICATION_SUMMARY = buildCoverageClassificationSummary(
  Object.values(ANDROID_EMULATOR_E2E_COVERAGE),
);

export function liveCommandsForScenario(scenarioId: string): PublicCommand[] {
  return Object.entries(ANDROID_EMULATOR_E2E_COVERAGE)
    .filter(([, entry]) => entry.level === 'live' && entry.scenario === scenarioId)
    .map(([command]) => command as PublicCommand);
}
