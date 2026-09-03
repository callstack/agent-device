import {
  APP_MOUNT_ISSUE_ID,
  COLD_SAMPLE_MINIMUM,
  DEEP_BUTTON_ISSUE_ID,
  ISSUE_ID,
  PARENT_ISSUE_ID,
  PROXY_RTT_VALUES,
  WARM_SAMPLE_MINIMUM,
  type LocalState,
  type ScreenFixture,
  type ScreenId,
} from './types.ts';

const FIXTURE_APP_ID = 'com.callstack.agentdevicelab';
const FIXTURE_SCHEME = 'agent-device-test-app://';
const IOS_SETTINGS_APP_ID = 'com.apple.Preferences';

const SCREEN_FIXTURES: readonly ScreenFixture[] = [
  {
    id: 'quiet',
    label: 'Quiet inert surface',
    app: FIXTURE_APP_ID,
    launchUrl: `${FIXTURE_SCHEME}/inert`,
    anchorText: 'Inert surface',
  },
  {
    id: 'list',
    label: 'Long catalog list',
    app: FIXTURE_APP_ID,
    launchUrl: `${FIXTURE_SCHEME}/catalog`,
    anchorText: 'Catalog',
  },
  {
    id: 'nested-scroll',
    label: 'WebView nested scroll',
    app: FIXTURE_APP_ID,
    launchUrl: `${FIXTURE_SCHEME}/webview`,
    anchorText: 'WebView accessibility',
  },
  {
    id: 'alert',
    label: 'Native alert',
    app: FIXTURE_APP_ID,
    launchUrl: `${FIXTURE_SCHEME}/automation`,
    anchorText: 'Automation lab',
    postSetupAnchorText: 'Automation confirmation',
    setupAction: 'open-alert',
  },
  {
    id: 'system-surface',
    label: 'iOS Settings system surface',
    app: IOS_SETTINGS_APP_ID,
    anchorText: 'Settings',
  },
  {
    id: 'xctest-stress',
    label: 'Dense checkout XCTest stress surface',
    app: FIXTURE_APP_ID,
    launchUrl: `${FIXTURE_SCHEME}/form`,
    anchorText: 'Checkout form',
  },
];

export function screenFixture(id: ScreenId): ScreenFixture {
  const fixture = SCREEN_FIXTURES.find((candidate) => candidate.id === id);
  if (!fixture) throw new Error(`Unknown screen fixture: ${id}`);
  return fixture;
}

export function parseScreenIds(value: string | undefined): ScreenId[] {
  const ids = (value ?? 'quiet,list,nested-scroll,alert,system-surface,xctest-stress')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean) as ScreenId[];
  const valid = new Set(SCREEN_FIXTURES.map((fixture) => fixture.id));
  const unknown = ids.filter((id) => !valid.has(id));
  if (unknown.length > 0) throw new Error(`Unknown --screen value: ${unknown.join(', ')}`);
  if (ids.length === 0) throw new Error('--screen requires at least one fixture.');
  return [...new Set(ids)];
}

export function parseLocalStates(value: string | undefined): LocalState[] {
  const states = (value ?? 'cold-cold,cold,warm,relaunch')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean) as LocalState[];
  const valid = new Set<LocalState>(['cold-cold', 'cold', 'warm', 'relaunch']);
  const unknown = states.filter((state) => !valid.has(state));
  if (unknown.length > 0) throw new Error(`Unknown --state value: ${unknown.join(', ')}`);
  if (states.length === 0) throw new Error('--state requires at least one cell.');
  return [...new Set(states)];
}

export function sampleMinimumForState(state: LocalState): number {
  return state === 'warm' || state === 'relaunch' ? WARM_SAMPLE_MINIMUM : COLD_SAMPLE_MINIMUM;
}

export function parseSampleCount(value: string | undefined, states: LocalState[]): number {
  const requested =
    value === undefined ? Math.max(...states.map(sampleMinimumForState)) : Number(value);
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(`--samples must be an integer >= 1 (got ${JSON.stringify(value)})`);
  }
  const minimum = Math.max(...states.map(sampleMinimumForState));
  if (requested < minimum) {
    throw new Error(`--samples must be at least ${minimum} for the selected state cells.`);
  }
  return requested;
}

export function parseRtt(value: string | undefined): (typeof PROXY_RTT_VALUES)[number][] {
  const values = (value ?? '0,20,80').split(',').map((item) => Number(item.trim()));
  if (
    values.some((item) => !PROXY_RTT_VALUES.includes(item as (typeof PROXY_RTT_VALUES)[number]))
  ) {
    throw new Error('--rtt must contain only 0, 20, or 80 milliseconds.');
  }
  return [...new Set(values)] as (typeof PROXY_RTT_VALUES)[number][];
}

export const CONTRACT = {
  issue: ISSUE_ID,
  parent: PARENT_ISSUE_ID,
  references: { deepButton: DEEP_BUTTON_ISSUE_ID, appMount: APP_MOUNT_ISSUE_ID },
  warmSampleMinimum: WARM_SAMPLE_MINIMUM,
  coldSampleMinimum: COLD_SAMPLE_MINIMUM,
} as const;
