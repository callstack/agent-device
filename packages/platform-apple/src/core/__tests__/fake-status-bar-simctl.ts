import type { FakeAppleToolResponse } from '../../__tests__/fake-apple-tool.ts';

/**
 * `simctl status_bar` with the simulator's own override state behind it. The production reader asks
 * the tool what the status bar currently shows, so a test can only prove what a capture would
 * restore to when the tool answers from state rather than from one fixed listing.
 */

export type StatusBarOverrideState = {
  time?: string;
  dataNetwork?: string;
  wifiMode?: string;
  wifiBars?: string;
  cellularMode?: string;
  cellularBars?: string;
  operatorName?: string;
  batteryState?: string;
  batteryLevel?: string;
};

export type FakeStatusBarSimctl = {
  /** Acts as the `withFakeAppleTool` script. */
  script(args: string[]): FakeAppleToolResponse;
  /** The override values the simulator holds now. */
  overrides(): StatusBarOverrideState;
  /** The state each `list` served, in order: one entry per snapshot a capture took. */
  servedSnapshots(): StatusBarOverrideState[];
};

const DATA_NETWORK_CODE: Record<string, number> = {
  hide: 0,
  wifi: 1,
  '3g': 6,
  '4g': 7,
  lte: 8,
  'lte-a': 9,
  'lte+': 10,
  '5g': 11,
  '5g+': 12,
  '5g-uwb': 13,
  '5g-uc': 14,
};

const WIFI_MODE_CODE: Record<string, number> = {
  searching: 1,
  failed: 2,
  active: 3,
};

const CELLULAR_MODE_CODE: Record<string, number> = {
  notSupported: 0,
  searching: 1,
  failed: 2,
  active: 3,
};

const OVERRIDE_OPTION_FIELDS = {
  '--time': 'time',
  '--dataNetwork': 'dataNetwork',
  '--wifiMode': 'wifiMode',
  '--wifiBars': 'wifiBars',
  '--cellularMode': 'cellularMode',
  '--cellularBars': 'cellularBars',
  '--operatorName': 'operatorName',
  '--batteryState': 'batteryState',
  '--batteryLevel': 'batteryLevel',
} as const satisfies Record<string, keyof StatusBarOverrideState>;

function parseOverrideOptions(args: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    if (option === undefined) break;
    options[option] = args[index + 1] ?? '';
  }
  return options;
}

/** One `list` line, rendered from the state fields it reads, or nothing when the state omits them. */
type StatusBarOverrideLine = {
  reads: (keyof StatusBarOverrideState)[];
  render: (state: StatusBarOverrideState) => string;
};

function codeOf(codes: Record<string, number>, value: string | undefined): number {
  return value === undefined ? 0 : (codes[value] ?? 0);
}

const STATUS_BAR_OVERRIDES_LISTING: StatusBarOverrideLine[] = [
  {
    reads: ['time'],
    render: (state) => `Time: ${state.time}`,
  },
  {
    reads: ['dataNetwork'],
    render: (state) => `DataNetworkType: ${codeOf(DATA_NETWORK_CODE, state.dataNetwork)}`,
  },
  {
    reads: ['wifiMode', 'wifiBars'],
    render: (state) =>
      `WiFi Mode: ${codeOf(WIFI_MODE_CODE, state.wifiMode)}, WiFi Bars: ${state.wifiBars ?? 0}`,
  },
  {
    reads: ['cellularMode', 'cellularBars'],
    render: (state) =>
      `Cell Mode: ${codeOf(CELLULAR_MODE_CODE, state.cellularMode)}, Cell Bars: ${state.cellularBars ?? 0}`,
  },
  {
    reads: ['operatorName'],
    render: (state) => `Operator Name: ${state.operatorName}`,
  },
  {
    reads: ['batteryState', 'batteryLevel'],
    render: (state) =>
      `Battery State: ${state.batteryState ? Number(state.batteryState === 'unplugged') : 0}, Battery Level: ${state.batteryLevel ?? 100}, Not Charging: 0`,
  },
];

/** Renders state the way `simctl status_bar <udid> list` does, codes and all. */
function renderStatusBarOverrides(state: StatusBarOverrideState): string {
  const lines = ['Current Status Bar Overrides:', '============================='];
  for (const entry of STATUS_BAR_OVERRIDES_LISTING) {
    if (entry.reads.every((field) => state[field] === undefined)) continue;
    lines.push(entry.render(state));
  }
  return lines.join('\n');
}

export function createFakeStatusBarSimctl(
  udid: string,
  initialOverrides: StatusBarOverrideState,
): FakeStatusBarSimctl {
  let state: StatusBarOverrideState = { ...initialOverrides };
  const servedSnapshots: StatusBarOverrideState[] = [];

  return {
    script: (args): FakeAppleToolResponse => {
      const unexpected = (detail: string): FakeAppleToolResponse => ({
        stderr: `unexpected status bar call: ${detail}`,
        exitCode: 1,
      });
      if (args[0] !== 'simctl' || args[1] !== 'status_bar' || args[2] !== udid) {
        return unexpected(args.join(' '));
      }
      const verb = args[3];
      if (verb === 'list') {
        servedSnapshots.push({ ...state });
        return renderStatusBarOverrides(state);
      }
      if (verb === 'clear') {
        state = {};
        return '';
      }
      if (verb !== 'override') return unexpected(args.join(' '));

      const applied: StatusBarOverrideState = {};
      for (const [option, value] of Object.entries(parseOverrideOptions(args.slice(4)))) {
        const field = OVERRIDE_OPTION_FIELDS[option as keyof typeof OVERRIDE_OPTION_FIELDS];
        if (field === undefined) return unexpected(`unknown option ${option}`);
        applied[field] = value;
      }
      state = { ...state, ...applied };
      return '';
    },
    overrides: () => ({ ...state }),
    servedSnapshots: () => servedSnapshots.map((snapshot) => ({ ...snapshot })),
  };
}
