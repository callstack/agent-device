import path from 'node:path';
import {
  parseLocalStates,
  parseSampleCount,
  parseScreenIds,
} from '../ios-snapshot-benchmark/definitions.ts';
import { resolveRepoRoot } from '../ios-snapshot-benchmark/host.ts';
import {
  assertBenchmarkOwner,
  assertOwnedDerivedPath,
  createBenchmarkStateRoot,
} from '../ios-snapshot-benchmark/state-ownership.ts';
import type { CandidateId, ResourceLimits } from './types.ts';
import { DEFAULT_SPIKE_LIMITS } from './limits.ts';

class SpikeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpikeConfigurationError';
  }
}

export type SpikeConfig = Readonly<{
  repoRoot: string;
  udid: string;
  guestBridge?: string;
  stateDir: string;
  derivedPath: string;
  outputPath: string;
  screens: ReturnType<typeof parseScreenIds>;
  states: ReturnType<typeof parseLocalStates>;
  samples: number;
  candidates: CandidateId[];
  limits: ResourceLimits;
  applyPreferences: boolean;
  keepDevice: boolean;
}>;

const CANDIDATES: readonly CandidateId[] = ['guest-simulator-framework-bridge', 'xctest-control'];
const BOOLEAN_FLAGS = new Set(['--apply-preferences', '--keep-device']);
const VALUE_FLAGS = new Set([
  '--udid',
  '--guest-bridge',
  '--state-dir',
  '--derived-path',
  '--out',
  '--screen',
  '--state',
  '--samples',
  '--candidate',
]);

export function parseConfig(argv: readonly string[]): SpikeConfig {
  const parsed = parseArguments(argv[0] === '--' ? argv.slice(1) : argv);
  const states = parseStates(parsed.values.get('--state'));
  const screens = parseScreens(parsed.values.get('--screen'));
  const candidates = parseCandidates(parsed.values.get('--candidate'));
  const samples = parseSamples(parsed.values.get('--samples'), states);
  const { stateDir, derivedPath } = resolveOwnedStatePaths(parsed.values);
  return {
    repoRoot: resolveRepoRoot(),
    udid: required(parsed.values, '--udid'),
    ...optionalPath(parsed.values.get('--guest-bridge'), 'guestBridge'),
    stateDir,
    derivedPath,
    outputPath: resolvePath(
      parsed.values.get('--out'),
      path.join(stateDir, 'ios-simulator-ax-bridge-spike.v1.json.gz'),
    ),
    screens,
    states,
    samples,
    candidates,
    limits: DEFAULT_SPIKE_LIMITS,
    applyPreferences: parsed.booleans.has('--apply-preferences'),
    keepDevice: parsed.booleans.has('--keep-device'),
  };
}

function resolveOwnedStatePaths(values: ReadonlyMap<string, string>): {
  stateDir: string;
  derivedPath: string;
} {
  const stateDir = values.has('--state-dir')
    ? resolvePath(values.get('--state-dir'), '')
    : createBenchmarkStateRoot();
  const derivedPath = resolvePath(
    values.get('--derived-path'),
    path.join(stateDir, 'derived-data'),
  );
  try {
    assertBenchmarkOwner(stateDir);
    assertOwnedDerivedPath(derivedPath, stateDir);
  } catch (error) {
    throw new SpikeConfigurationError(error instanceof Error ? error.message : String(error));
  }
  return { stateDir, derivedPath };
}

function parseArguments(argv: readonly string[]): {
  values: Map<string, string>;
  booleans: Set<string>;
} {
  exitAfterHelp(argv);
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = parseArgument(argv, index);
    recordArgument(argument, values, booleans);
    index = argument.nextIndex;
  }
  return { values, booleans };
}

function exitAfterHelp(argv: readonly string[]): void {
  if (!argv.includes('--help') && !argv.includes('-h')) return;
  printHelp();
  process.exit(0);
}

function recordArgument(
  argument: { flag: string; value?: string },
  values: Map<string, string>,
  booleans: Set<string>,
): void {
  if (argument.value === undefined) booleans.add(argument.flag);
  else values.set(argument.flag, argument.value);
}

function parseArgument(
  argv: readonly string[],
  index: number,
): { flag: string; value?: string; nextIndex: number } {
  const flag = argv[index];
  if (flag === undefined) throw new SpikeConfigurationError('Missing option.');
  if (BOOLEAN_FLAGS.has(flag)) return { flag, nextIndex: index };
  return parseValueArgument(flag, argv[index + 1], index);
}

function parseValueArgument(
  flag: string,
  value: string | undefined,
  index: number,
): { flag: string; value: string; nextIndex: number } {
  if (!VALUE_FLAGS.has(flag)) throw new SpikeConfigurationError(`Unknown option: ${flag}`);
  if (!value || value.startsWith('--')) {
    throw new SpikeConfigurationError(`${flag} requires a value.`);
  }
  return { flag, value, nextIndex: index + 1 };
}

function parseStates(value: string | undefined): SpikeConfig['states'] {
  try {
    return parseLocalStates(value);
  } catch (error) {
    throw new SpikeConfigurationError(error instanceof Error ? error.message : String(error));
  }
}

function parseScreens(value: string | undefined): SpikeConfig['screens'] {
  try {
    return parseScreenIds(value);
  } catch (error) {
    throw new SpikeConfigurationError(error instanceof Error ? error.message : String(error));
  }
}

function parseSamples(value: string | undefined, states: SpikeConfig['states']): number {
  try {
    return parseSampleCount(value, states);
  } catch (error) {
    throw new SpikeConfigurationError(error instanceof Error ? error.message : String(error));
  }
}

function parseCandidates(value: string | undefined): CandidateId[] {
  const candidates = (value ?? CANDIDATES.join(','))
    .split(',')
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  const unknown = candidates.filter((candidate) => !CANDIDATES.includes(candidate as CandidateId));
  if (unknown.length > 0)
    throw new SpikeConfigurationError(`Unknown --candidate value: ${unknown.join(', ')}`);
  if (candidates.length === 0)
    throw new SpikeConfigurationError('--candidate requires at least one value.');
  return [...new Set(candidates)] as CandidateId[];
}

function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (!value) throw new SpikeConfigurationError(`${flag} is required for a reproducible run.`);
  return value;
}

function optionalPath(
  value: string | undefined,
  key: 'guestBridge',
): { guestBridge: string } | Record<string, never> {
  return value === undefined ? {} : { [key]: path.resolve(value) };
}

function resolvePath(value: string | undefined, fallback: string): string {
  return path.resolve(value ?? fallback);
}

function printHelp(): void {
  process.stdout.write(
    `Usage: pnpm bench:ios-ax-bridge -- [options]\n\nRequired:\n  --udid <simulator-udid>\n\nOptions:\n  --candidate <list>             guest-simulator-framework-bridge, xctest-control\n  --state <list>                 #2189 state names\n  --screen <list>                #2189 fixture names\n  --samples <n>                  #2189 minimums: cold 10, warm/relaunch 20\n  --apply-preferences            apply task-owned preboot AX preference experiment\n  --guest-bridge <path>          official idb 1.5.2 Resources/SimulatorFrameworkBridge guest executable\n  --out <path>                   raw JSON report path\n  --keep-device                  leave the dedicated Simulator shutdown/boot state unchanged\n`,
  );
}
