import {
  assertCoverageComplete as assertLiveCoverageComplete,
  writeCoverageReport as writeLiveCoverageReport,
} from '../live-device-e2e/coverage.ts';
import {
  ANDROID_EMULATOR_BEHAVIOR_COVERAGE,
  type AndroidEmulatorBehaviorId,
} from './behavior-coverage.ts';
import { ANDROID_EMULATOR_E2E_COVERAGE, liveCommandsForScenario } from './coverage-manifest.ts';
import type { LiveContext } from './live-harness.ts';

const REQUIRED_SCENARIOS = [
  ...new Set([
    ...Object.values(ANDROID_EMULATOR_E2E_COVERAGE)
      .filter((entry) => entry.level === 'live')
      .map((entry) => entry.scenario),
    ...Object.values(ANDROID_EMULATOR_BEHAVIOR_COVERAGE).map((entry) => entry.owner),
  ]),
].map((id) => ({ id }));

export function assertCoverageComplete(context: LiveContext): void {
  assertLiveCoverageComplete(
    context,
    REQUIRED_SCENARIOS,
    liveCommandsForScenario,
    liveBehaviorsForScenario,
    'Android emulator E2E coverage is incomplete',
  );
}

export function writeCoverageReport(context: LiveContext): string {
  return writeLiveCoverageReport(context);
}

export function liveBehaviorsForScenario(scenarioId: string): AndroidEmulatorBehaviorId[] {
  return Object.entries(ANDROID_EMULATOR_BEHAVIOR_COVERAGE)
    .filter(([, entry]) => entry.owner === scenarioId)
    .map(([behavior]) => behavior as AndroidEmulatorBehaviorId);
}
