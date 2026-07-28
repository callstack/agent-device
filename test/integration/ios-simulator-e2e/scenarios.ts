export type IosSimulatorScenario = {
  id: string;
  tier: 'smoke' | 'full';
};

type ScenarioRunnerKey =
  | 'automationInput'
  | 'captureClose'
  | 'deviceLifecycle'
  | 'fixtureReplays'
  | 'formInput'
  | 'inventoryInstall'
  | 'knownGaps'
  | 'lifecycleSystem'
  | 'observabilityArtifacts';

type ScenarioDefinition = IosSimulatorScenario & {
  runner: ScenarioRunnerKey;
};

const SCENARIO_DEFINITIONS: readonly ScenarioDefinition[] = [
  { id: 'smoke:inventory-install', runner: 'inventoryInstall', tier: 'smoke' },
  { id: 'smoke:automation-input', runner: 'automationInput', tier: 'smoke' },
  { id: 'smoke:form-input', runner: 'formInput', tier: 'smoke' },
  { id: 'smoke:capture-close', runner: 'captureClose', tier: 'smoke' },
  { id: 'full:lifecycle-system', runner: 'lifecycleSystem', tier: 'full' },
  {
    id: 'full:observability-artifacts',
    runner: 'observabilityArtifacts',
    tier: 'full',
  },
  { id: 'full:known-gaps', runner: 'knownGaps', tier: 'full' },
  { id: 'full:fixture-replays', runner: 'fixtureReplays', tier: 'full' },
  { id: 'full:device-lifecycle', runner: 'deviceLifecycle', tier: 'full' },
] as const;

export const IOS_SIMULATOR_LIVE_SCENARIOS: readonly IosSimulatorScenario[] = SCENARIO_DEFINITIONS;

export function bindIosSimulatorScenarios<Context>(
  runners: Record<ScenarioRunnerKey, (context: Context) => Promise<void>>,
): readonly (IosSimulatorScenario & { run: (context: Context) => Promise<void> })[] {
  return SCENARIO_DEFINITIONS.map(({ id, runner, tier }) => ({
    id,
    run: runners[runner],
    tier,
  }));
}
