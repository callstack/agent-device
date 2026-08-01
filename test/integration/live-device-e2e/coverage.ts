import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import type { LiveDeviceContext } from './runtime.ts';

export function computeMissingCoverage<BehaviorId extends string>(
  context: LiveDeviceContext<BehaviorId>,
  scenarios: readonly { id: string }[],
  commandsForScenario: (scenarioId: string) => readonly string[],
  behaviorsForScenario: (scenarioId: string) => readonly BehaviorId[],
) {
  return {
    missingBehaviors: scenarios
      .flatMap((scenario) => behaviorsForScenario(scenario.id))
      .filter((behavior) => (context.behaviorEvidence[behavior]?.length ?? 0) === 0),
    missingCommands: scenarios
      .flatMap((scenario) => commandsForScenario(scenario.id))
      .filter((command) => (context.commandEvidence[command]?.length ?? 0) === 0),
    missingScenarios: scenarios
      .map((scenario) => scenario.id)
      .filter((id) => !context.completedScenarios.includes(id)),
  };
}

export function assertCoverageComplete<BehaviorId extends string>(
  context: LiveDeviceContext<BehaviorId>,
  scenarios: readonly { id: string }[],
  commandsForScenario: (scenarioId: string) => readonly string[],
  behaviorsForScenario: (scenarioId: string) => readonly BehaviorId[],
  message: string,
): void {
  assert.deepEqual(
    computeMissingCoverage(context, scenarios, commandsForScenario, behaviorsForScenario),
    { missingBehaviors: [], missingCommands: [], missingScenarios: [] },
    message,
  );
}

export function writeCoverageReport<BehaviorId extends string>(
  context: LiveDeviceContext<BehaviorId>,
  extra: Record<string, unknown> = {},
): string {
  const reportPath = path.join(context.artifactDir, 'coverage-report.json');
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        behaviorEvidence: context.behaviorEvidence,
        commandEvidence: context.commandEvidence,
        completedScenarios: context.completedScenarios,
        ...extra,
        timings: {
          runDurationMs: Date.now() - context.startedAtMs,
          scenarios: context.timings,
        },
      },
      null,
      2,
    ),
  );
  return reportPath;
}
