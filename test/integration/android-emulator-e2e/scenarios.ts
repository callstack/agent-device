export type AndroidEmulatorScenario = {
  id: string;
  source: string;
};

type ScenarioRunnerKey = 'automationSystem' | 'captureClose' | 'formInput' | 'inventoryInstall';

type ScenarioDefinition = AndroidEmulatorScenario & { runner: ScenarioRunnerKey };

const SCENARIO_DEFINITIONS: readonly ScenarioDefinition[] = [
  {
    id: 'smoke:inventory-install',
    runner: 'inventoryInstall',
    source: 'test/integration/android-emulator-e2e/live-inventory-scenario.ts',
  },
  {
    id: 'smoke:automation-system',
    runner: 'automationSystem',
    source: 'test/integration/android-emulator-e2e/live-automation-scenario.ts',
  },
  {
    id: 'smoke:form-input',
    runner: 'formInput',
    source: 'test/integration/android-emulator-e2e/live-form-scenario.ts',
  },
  {
    id: 'smoke:capture-close',
    runner: 'captureClose',
    source: 'test/integration/android-emulator-e2e/live-runner.ts',
  },
] as const;

export const ANDROID_EMULATOR_LIVE_SCENARIOS: readonly AndroidEmulatorScenario[] =
  SCENARIO_DEFINITIONS;

export function bindAndroidEmulatorScenarios<Context>(
  runners: Record<ScenarioRunnerKey, (context: Context) => Promise<void>>,
): readonly (AndroidEmulatorScenario & { run: (context: Context) => Promise<void> })[] {
  return SCENARIO_DEFINITIONS.map(({ id, source, runner }) => ({
    id,
    run: runners[runner],
    source,
  }));
}
