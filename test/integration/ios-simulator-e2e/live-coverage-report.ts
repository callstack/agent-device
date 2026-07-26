import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  IOS_SIMULATOR_BEHAVIOR_COVERAGE,
  type IosSimulatorBehaviorId,
} from './behavior-coverage.ts';
import type { LiveContext, Tier } from './live-harness.ts';
import { IOS_SIMULATOR_LIVE_SCENARIOS, type IosSimulatorScenario } from './scenarios.ts';

export function assertCoverageComplete(context: LiveContext): void {
  const requiredScenarios = scenariosForTier(context.tier);
  const missingScenarios = requiredScenarios
    .map((scenario) => scenario.id)
    .filter((id) => !context.completedScenarios.includes(id));
  const missingCommands = requiredScenarios
    .flatMap((scenario) => scenario.commands)
    .filter((command) => (context.commandEvidence[command]?.length ?? 0) === 0);
  const missingBehaviors = requiredScenarios
    .flatMap((scenario) => liveBehaviorsForScenario(scenario.id))
    .filter((behavior) => (context.behaviorEvidence[behavior]?.length ?? 0) === 0);
  assert.deepEqual(
    { missingBehaviors, missingCommands, missingScenarios },
    { missingBehaviors: [], missingCommands: [], missingScenarios: [] },
    'iOS simulator E2E coverage is incomplete',
  );
}

export function writeCoverageReport(context: LiveContext): void {
  const requiredScenarios = scenariosForTier(context.tier);
  const missingScenarios = requiredScenarios
    .map((scenario) => scenario.id)
    .filter((id) => !context.completedScenarios.includes(id));
  const missingCommands = requiredScenarios
    .flatMap((scenario) => scenario.commands)
    .filter((command) => (context.commandEvidence[command]?.length ?? 0) === 0);
  const missingBehaviors = requiredScenarios
    .flatMap((scenario) => liveBehaviorsForScenario(scenario.id))
    .filter((behavior) => (context.behaviorEvidence[behavior]?.length ?? 0) === 0);
  fs.writeFileSync(
    path.join(context.artifactDir, 'coverage-report.json'),
    JSON.stringify(
      {
        behaviorEvidence: context.behaviorEvidence,
        commandEvidence: context.commandEvidence,
        completedScenarios: context.completedScenarios,
        missingBehaviors,
        missingCommands,
        missingScenarios,
        tier: context.tier,
      },
      null,
      2,
    ),
  );
}

export function scenariosForTier(tier: Tier): readonly IosSimulatorScenario[] {
  return IOS_SIMULATOR_LIVE_SCENARIOS.filter(
    (scenario) => scenario.tier === 'smoke' || tier === 'full',
  );
}

export function liveBehaviorsForScenario(scenarioId: string): IosSimulatorBehaviorId[] {
  return Object.entries(IOS_SIMULATOR_BEHAVIOR_COVERAGE)
    .filter(([, entry]) => entry.level === 'live' && entry.owner === scenarioId)
    .map(([behavior]) => behavior as IosSimulatorBehaviorId);
}
