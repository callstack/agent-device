import {
  assertCoverageComplete,
  cleanupSession,
  createContext,
  runScenario,
  sessionExists,
  writeCoverageReport,
} from './live-harness.ts';
import { ANDROID_EMULATOR_FIXTURE_BOOTSTRAP, selectAndroidEmulatorScenarios } from './scenarios.ts';
import { prepareAndroidEmulatorScenario } from './scenario-start.ts';

const SCENARIO_FILTER_ENV = 'AGENT_DEVICE_ANDROID_E2E_SCENARIOS';

export type AndroidEmulatorE2EOptions = {
  scenarioIds?: readonly string[];
};

export async function runAndroidEmulatorE2E(
  options: AndroidEmulatorE2EOptions = {},
): Promise<void> {
  const requestedIds = options.scenarioIds ?? scenarioIdsFromEnv(process.env[SCENARIO_FILTER_ENV]);
  const selectedScenarios = selectAndroidEmulatorScenarios(requestedIds);
  const executedScenarios = [ANDROID_EMULATOR_FIXTURE_BOOTSTRAP, ...selectedScenarios];
  const context = createContext();
  let primaryError: unknown;
  try {
    for (const scenario of executedScenarios) {
      await runScenario(context, {
        id: scenario.id,
        run: async (scenarioContext) => {
          await prepareAndroidEmulatorScenario(scenarioContext, scenario.start);
          await scenario.run(scenarioContext);
        },
      });
    }
    assertCoverageComplete(context, executedScenarios);
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown;
  try {
    context.sessionOpen = context.sessionOpen || (await sessionExists(context));
    await cleanupSession(context);
  } catch (error) {
    cleanupError = error;
  }
  try {
    const reportPath = writeCoverageReport(context);
    console.log(`Android emulator coverage report: ${reportPath}`);
    console.log(`Android emulator live run: ${Date.now() - context.startedAtMs}ms`);
    for (const timing of context.timings) {
      console.log(`  ${timing.id}: ${timing.durationMs}ms`);
    }
  } catch (error) {
    cleanupError = cleanupError ?? error;
  }
  if (primaryError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [primaryError, cleanupError],
      'Android E2E failed and cleanup also failed',
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
}

export function scenarioIdsFromEnv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const scenarioIds = value
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (scenarioIds.length === 0) {
    throw new Error(`${SCENARIO_FILTER_ENV} contains no Android emulator E2E scenario ids`);
  }
  return scenarioIds;
}
