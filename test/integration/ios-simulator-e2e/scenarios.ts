export type IosSimulatorScenario = { id: string } & (
  | { tier: 'smoke'; setup: 'no-session' | 'scenario-owned' | 'fixture-home' }
  | { tier: 'full' }
);

type ScenarioRunnerKey =
  | 'automationInput'
  | 'captureClose'
  | 'deepLinkNavigation'
  | 'deviceLifecycle'
  | 'fixtureReplays'
  | 'formInput'
  | 'inventoryInstall'
  | 'lifecycleSystem'
  | 'observabilityArtifacts'
  | 'snapshotDepthFrontier'
  | 'webviewRemoteContent';

type ScenarioDefinition = IosSimulatorScenario & {
  runner: ScenarioRunnerKey;
};

const SCENARIO_DEFINITIONS: readonly ScenarioDefinition[] = [
  { id: 'smoke:inventory-install', setup: 'no-session', runner: 'inventoryInstall', tier: 'smoke' },
  {
    id: 'smoke:automation-input',
    setup: 'scenario-owned',
    runner: 'automationInput',
    tier: 'smoke',
  },
  { id: 'smoke:form-input', setup: 'fixture-home', runner: 'formInput', tier: 'smoke' },
  {
    id: 'smoke:regular-visible-depth-frontier',
    setup: 'fixture-home',
    runner: 'snapshotDepthFrontier',
    tier: 'smoke',
  },
  {
    id: 'smoke:webview-remote-content',
    setup: 'fixture-home',
    runner: 'webviewRemoteContent',
    tier: 'smoke',
  },
  {
    id: 'smoke:deep-link-navigation',
    setup: 'scenario-owned',
    runner: 'deepLinkNavigation',
    tier: 'smoke',
  },
  { id: 'smoke:capture-close', setup: 'fixture-home', runner: 'captureClose', tier: 'smoke' },
  { id: 'full:lifecycle-system', runner: 'lifecycleSystem', tier: 'full' },
  {
    id: 'full:observability-artifacts',
    runner: 'observabilityArtifacts',
    tier: 'full',
  },
  { id: 'full:fixture-replays', runner: 'fixtureReplays', tier: 'full' },
  { id: 'full:device-lifecycle', runner: 'deviceLifecycle', tier: 'full' },
] as const;

export const IOS_SIMULATOR_LIVE_SCENARIOS: readonly IosSimulatorScenario[] = SCENARIO_DEFINITIONS;

export function bindIosSimulatorScenarios<Context>(
  runners: Record<ScenarioRunnerKey, (context: Context) => Promise<void>>,
): readonly (IosSimulatorScenario & { run: (context: Context) => Promise<void> })[] {
  return SCENARIO_DEFINITIONS.map(({ runner, ...scenario }) => ({
    ...scenario,
    run: runners[runner],
  }));
}
