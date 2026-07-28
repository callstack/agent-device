import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  IOS_SIMULATOR_BEHAVIOR_COVERAGE,
  type IosSimulatorBehaviorId,
} from './behavior-coverage.ts';
import { liveCommandsForScenario } from './coverage-manifest.ts';
import type { LiveContext, Tier } from './live-harness.ts';
import { IOS_SIMULATOR_LIVE_SCENARIOS, type IosSimulatorScenario } from './scenarios.ts';

export function assertCoverageComplete(context: LiveContext): void {
  const missing = computeMissing(context);
  assert.deepEqual(
    missing,
    { missingBehaviors: [], missingCommands: [], missingScenarios: [] },
    'iOS simulator E2E coverage is incomplete',
  );
}

export function writeCoverageReport(context: LiveContext): void {
  const missing = computeMissing(context);
  fs.writeFileSync(
    path.join(context.artifactDir, 'coverage-report.json'),
    JSON.stringify(
      {
        behaviorEvidence: context.behaviorEvidence,
        commandEvidence: context.commandEvidence,
        completedScenarios: context.completedScenarios,
        ...missing,
        tier: context.tier,
      },
      null,
      2,
    ),
  );
}

function computeMissing(context: LiveContext) {
  const requiredScenarios = scenariosForTier(context.tier);
  return {
    missingBehaviors: requiredScenarios
      .flatMap((scenario) => liveBehaviorsForScenario(scenario.id))
      .filter((behavior) => (context.behaviorEvidence[behavior]?.length ?? 0) === 0),
    missingCommands: requiredScenarios
      .flatMap((scenario) => liveCommandsForScenario(scenario.id))
      .filter((command) => (context.commandEvidence[command]?.length ?? 0) === 0),
    missingScenarios: requiredScenarios
      .map((scenario) => scenario.id)
      .filter((id) => !context.completedScenarios.includes(id)),
  };
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
