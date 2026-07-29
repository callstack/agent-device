import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  ANDROID_EMULATOR_BEHAVIOR_COVERAGE,
  type AndroidEmulatorBehaviorId,
} from './behavior-coverage.ts';
import { liveCommandsForScenario } from './coverage-manifest.ts';
import type { LiveContext } from './live-harness.ts';
import { ANDROID_EMULATOR_LIVE_SCENARIOS } from './scenarios.ts';

const MAX_ANDROID_EMULATOR_SCENARIO_BODY_MS = 4 * 60 * 1000;

export function assertCoverageComplete(context: LiveContext): void {
  const missingCommands = ANDROID_EMULATOR_LIVE_SCENARIOS.flatMap((scenario) =>
    liveCommandsForScenario(scenario.id).filter(
      (command) => !context.commandEvidence[command]?.length,
    ),
  );
  const missingBehaviors = Object.entries(ANDROID_EMULATOR_BEHAVIOR_COVERAGE)
    .filter(([, entry]) => entry.level === 'live')
    .map(([behavior]) => behavior as AndroidEmulatorBehaviorId)
    .filter((behavior) => !context.behaviorEvidence[behavior]?.length);
  const missingScenarios = ANDROID_EMULATOR_LIVE_SCENARIOS.map((scenario) => scenario.id).filter(
    (id) => !context.completedScenarios.includes(id),
  );
  assert.deepEqual(
    { missingBehaviors, missingCommands, missingScenarios },
    { missingBehaviors: [], missingCommands: [], missingScenarios: [] },
    'Android emulator E2E coverage is incomplete',
  );
  const totalDurationMs = Date.now() - context.startedAtMs;
  assert.ok(
    totalDurationMs <= MAX_ANDROID_EMULATOR_SCENARIO_BODY_MS,
    `Android emulator scenario body took ${totalDurationMs}ms; limit is ${MAX_ANDROID_EMULATOR_SCENARIO_BODY_MS}ms`,
  );
}

export function writeCoverageReport(context: LiveContext): void {
  fs.writeFileSync(
    path.join(context.artifactDir, 'coverage-report.json'),
    JSON.stringify(
      {
        behaviorEvidence: context.behaviorEvidence,
        commandEvidence: context.commandEvidence,
        completedScenarios: context.completedScenarios,
        stepHistory: context.stepHistory,
        timings: {
          scenarioBodyDurationMs: Date.now() - context.startedAtMs,
          scenarios: context.timings,
        },
      },
      null,
      2,
    ),
  );
}

export function liveBehaviorsForScenario(scenarioId: string): AndroidEmulatorBehaviorId[] {
  return Object.entries(ANDROID_EMULATOR_BEHAVIOR_COVERAGE)
    .filter(([, entry]) => entry.level === 'live' && entry.owner === scenarioId)
    .map(([behavior]) => behavior as AndroidEmulatorBehaviorId);
}
