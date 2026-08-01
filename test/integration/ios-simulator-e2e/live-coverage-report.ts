import {
  assertCoverageComplete as assertLiveCoverageComplete,
  computeMissingCoverage,
  writeCoverageReport as writeLiveCoverageReport,
} from '../live-device-e2e/coverage.ts';
import {
  IOS_SIMULATOR_BEHAVIOR_COVERAGE,
  type IosSimulatorBehaviorId,
} from './behavior-coverage.ts';
import { liveCommandsForScenario } from './coverage-manifest.ts';
import type { LiveContext, Tier } from './live-harness.ts';
import { IOS_SIMULATOR_LIVE_SCENARIOS, type IosSimulatorScenario } from './scenarios.ts';

export function assertCoverageComplete(context: LiveContext): void {
  assertLiveCoverageComplete(
    context,
    scenariosForTier(context.tier),
    liveCommandsForScenario,
    liveBehaviorsForScenario,
    'iOS simulator E2E coverage is incomplete',
  );
}

export function writeCoverageReport(context: LiveContext): void {
  const scenarios = scenariosForTier(context.tier);
  writeLiveCoverageReport(context, {
    ...computeMissingCoverage(
      context,
      scenarios,
      liveCommandsForScenario,
      liveBehaviorsForScenario,
    ),
    tier: context.tier,
  });
}

function scenariosForTier(tier: Tier): readonly IosSimulatorScenario[] {
  return IOS_SIMULATOR_LIVE_SCENARIOS.filter(
    (scenario) => scenario.tier === 'smoke' || tier === 'full',
  );
}

export function liveBehaviorsForScenario(scenarioId: string): IosSimulatorBehaviorId[] {
  return Object.entries(IOS_SIMULATOR_BEHAVIOR_COVERAGE)
    .filter(([, entry]) => entry.level === 'live' && entry.owner === scenarioId)
    .map(([behavior]) => behavior as IosSimulatorBehaviorId);
}
