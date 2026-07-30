import {
  assertCoverageComplete as assertLiveCoverageComplete,
  writeCoverageReport as writeLiveCoverageReport,
} from '../live-device-e2e/coverage.ts';
import {
  ANDROID_EMULATOR_BEHAVIOR_COVERAGE,
  type AndroidEmulatorBehaviorId,
} from './behavior-coverage.ts';
import {
  ANDROID_EMULATOR_COVERAGE_CLASSIFICATION_SUMMARY,
  liveCommandsForScenario,
} from './coverage-manifest.ts';
import type { LiveContext } from './live-harness.ts';

export function assertCoverageComplete(
  context: LiveContext,
  selectedScenarios: readonly { id: string }[],
): void {
  assertLiveCoverageComplete(
    context,
    selectedScenarios,
    liveCommandsForScenario,
    liveBehaviorsForScenario,
    'Android emulator E2E coverage is incomplete',
  );
}

export function writeCoverageReport(context: LiveContext): string {
  return writeLiveCoverageReport(context, {
    classificationSummary: ANDROID_EMULATOR_COVERAGE_CLASSIFICATION_SUMMARY,
  });
}

export function liveBehaviorsForScenario(scenarioId: string): AndroidEmulatorBehaviorId[] {
  return Object.entries(ANDROID_EMULATOR_BEHAVIOR_COVERAGE)
    .filter(([, entry]) => entry.owner === scenarioId)
    .map(([behavior]) => behavior as AndroidEmulatorBehaviorId);
}
