import path from 'node:path';
import { parseLocalStates, parseRtt, parseSampleCount, parseScreenIds } from './definitions.ts';
import { resolveRepoRoot } from './host.ts';
import {
  assertBenchmarkOwner,
  assertOwnedDerivedPath,
  createBenchmarkStateRoot,
} from './state-ownership.ts';
import type { LocalState, ScreenId } from './types.ts';

export class BenchmarkConfigurationError extends Error {}

export type BenchmarkConfig = {
  repoRoot: string;
  mode: 'local' | 'proxy' | 'all';
  udid: string;
  appId: string;
  appPath?: string;
  stateDir: string;
  outputPath: string;
  derivedPath: string;
  screens: ScreenId[];
  states: LocalState[];
  samples: number;
  rtts: readonly number[];
  bandwidthKbps: number | null;
  packetLossPercent: number;
  seed: number;
  skipPackageSize: boolean;
  keepDevice: boolean;
};

type ParsedArguments = { values: Map<string, string>; booleans: Set<string> };
type ParsedOption = { flag: string; value?: string; boolean: boolean };

const DEFAULT_APP_ID = 'com.callstack.agentdevicelab';
const MODES: ReadonlySet<BenchmarkConfig['mode']> = new Set(['local', 'proxy', 'all']);
const BOOLEAN_FLAGS = new Set(['--skip-package-size', '--keep-device']);
const VALUE_FLAGS = new Set([
  '--mode',
  '--udid',
  '--app-id',
  '--app-path',
  '--state-dir',
  '--derived-path',
  '--out',
  '--screen',
  '--state',
  '--samples',
  '--rtt',
  '--bandwidth-kbps',
  '--packet-loss',
  '--seed',
]);

export function parseConfig(argv: string[]): BenchmarkConfig {
  const arguments_ = parseArguments(argv);
  const mode = readMode(arguments_.values.get('--mode'));
  const udid = requireValue(arguments_.values, '--udid');
  const cells = readCells(arguments_.values, mode);
  const paths = readPaths(arguments_.values);
  const network = readNetwork(arguments_.values);
  return {
    repoRoot: resolveRepoRoot(),
    mode,
    udid,
    appId: arguments_.values.get('--app-id') ?? DEFAULT_APP_ID,
    ...paths,
    ...cells,
    ...network,
    skipPackageSize: arguments_.booleans.has('--skip-package-size'),
    keepDevice: arguments_.booleans.has('--keep-device'),
  };
}

function parseArguments(argv: string[]): ParsedArguments {
  const normalized = argv[0] === '--' ? argv.slice(1) : argv;
  exitForHelp(normalized);
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < normalized.length; index += 1) {
    const option = readOption(normalized[index]!, normalized[index + 1]);
    addOption(option, values, booleans);
    if (!option.boolean) index += 1;
  }
  return { values, booleans };
}

function exitForHelp(argv: string[]): void {
  if (!argv.includes('--help') && !argv.includes('-h')) return;
  printHelp();
  process.exit(0);
}

function addOption(option: ParsedOption, values: Map<string, string>, booleans: Set<string>): void {
  if (option.boolean) {
    booleans.add(option.flag);
    return;
  }
  values.set(option.flag, option.value!);
}

function readOption(arg: string, next: string | undefined): ParsedOption {
  if (BOOLEAN_FLAGS.has(arg)) return { flag: arg, boolean: true };
  if (!arg.startsWith('--')) throw new BenchmarkConfigurationError(`Unexpected argument: ${arg}`);
  if (!VALUE_FLAGS.has(arg)) throw new BenchmarkConfigurationError(`Unknown option: ${arg}`);
  return { flag: arg, value: requireNextValue(arg, next), boolean: false };
}

function requireNextValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new BenchmarkConfigurationError(`${flag} requires a value.`);
  }
  return value;
}

function readMode(value: string | undefined): BenchmarkConfig['mode'] {
  const mode = value ?? 'local';
  if (!MODES.has(mode as BenchmarkConfig['mode'])) {
    throw new BenchmarkConfigurationError(`--mode must be local, proxy, or all (got ${mode}).`);
  }
  return mode as BenchmarkConfig['mode'];
}

function requireValue(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (!value) throw new BenchmarkConfigurationError(`${flag} is required for a reproducible run.`);
  return value;
}

function readCells(
  values: Map<string, string>,
  mode: BenchmarkConfig['mode'],
): {
  states: LocalState[];
  screens: ScreenId[];
  samples: number;
} {
  try {
    const states = parseLocalStates(values.get('--state'));
    return {
      states,
      screens: parseScreenIds(values.get('--screen')),
      samples: parseSampleCount(values.get('--samples'), sampleMinimumStates(states, mode)),
    };
  } catch (error) {
    throw new BenchmarkConfigurationError(error instanceof Error ? error.message : String(error));
  }
}

function sampleMinimumStates(states: LocalState[], mode: BenchmarkConfig['mode']): LocalState[] {
  return mode === 'local' ? states : [...states, 'warm'];
}

function readPaths(
  values: Map<string, string>,
): Pick<BenchmarkConfig, 'stateDir' | 'outputPath' | 'derivedPath' | 'appPath'> {
  const stateDir = values.has('--state-dir')
    ? resolvePath(values.get('--state-dir'), '')
    : createBenchmarkStateRoot();
  const appPath = values.get('--app-path');
  const derivedPath = resolvePath(
    values.get('--derived-path'),
    path.join(stateDir, 'derived-data'),
  );
  try {
    assertBenchmarkOwner(stateDir);
    assertOwnedDerivedPath(derivedPath, stateDir);
  } catch (error) {
    throw new BenchmarkConfigurationError(error instanceof Error ? error.message : String(error));
  }
  return {
    stateDir,
    outputPath: resolvePath(
      values.get('--out'),
      path.join(stateDir, 'ios-snapshot-convergence.v1.json'),
    ),
    derivedPath,
    ...optionalAppPath(appPath),
  };
}

function resolvePath(value: string | undefined, fallback: string): string {
  return path.resolve(value ?? fallback);
}

function optionalAppPath(appPath: string | undefined): Pick<BenchmarkConfig, 'appPath'> {
  return appPath === undefined ? {} : { appPath };
}

function readNetwork(
  values: Map<string, string>,
): Pick<BenchmarkConfig, 'rtts' | 'bandwidthKbps' | 'packetLossPercent' | 'seed'> {
  const packetLoss = values.get('--packet-loss') ?? '0';
  const seed = values.get('--seed') ?? '2189';
  return {
    rtts: parseRtt(values.get('--rtt')),
    bandwidthKbps: readBandwidth(values.get('--bandwidth-kbps')),
    packetLossPercent: parseNumber(packetLoss, '--packet-loss', 0, 100),
    seed: parsePositiveInteger(seed, '--seed'),
  };
}

function readBandwidth(value: string | undefined): number | null {
  if (value === undefined || value === 'unlimited') return null;
  return parsePositiveInteger(value, '--bandwidth-kbps');
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BenchmarkConfigurationError(`${flag} must be an integer >= 1.`);
  }
  return parsed;
}

function parseNumber(value: string, flag: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new BenchmarkConfigurationError(`${flag} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function printHelp(): void {
  process.stdout.write(`Usage: pnpm bench:ios-snapshot -- [options]

Capture runner-backed iOS Simulator snapshot convergence evidence and raw JSON.

Required:
  --udid <simulator-udid>

Options:
  --mode local|proxy|all       Measurement transport (default local).
  --app-id <bundle-id>         Target bundle identifier (default fixture app).
  --app-path <path>            Optional target artifact path recorded in metadata.
  --screen <csv>               quiet,list,nested-scroll,alert,system-surface,xctest-stress.
  --state <csv>                cold-cold,cold,warm,relaunch.
  --samples <n>                At least 10 cold or 20 warm/relaunch samples.
  --rtt <csv>                  Proxy RTT cells: 0,20,80 (default all).
  --bandwidth-kbps <n|unlimited>
  --packet-loss <percent>      Deterministic loss rate for proxy requests.
  --seed <n>                   Deterministic proxy loss seed.
  --state-dir <path>           Existing pre-marked benchmark state directory; omit for a fresh root.
  --derived-path <path>        Isolated iOS XCTest derived-data path.
  --out <path>                 Raw JSON output path.
  --skip-package-size          Omit packed/clean-installed/bundled measurement.
  --keep-device                Leave the selected simulator booted.
`);
}
