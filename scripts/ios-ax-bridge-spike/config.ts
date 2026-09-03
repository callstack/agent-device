import path from 'node:path';
import { resolveRepoRoot } from '../ios-snapshot-benchmark/host.ts';
import { createBenchmarkStateRoot } from '../ios-snapshot-benchmark/state-ownership.ts';
import { DEFAULT_SPIKE_LIMITS } from './limits.ts';
import type { ResourceLimits } from './types.ts';

class SpikeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpikeConfigurationError';
  }
}

export type SpikeConfig = Readonly<{
  repoRoot: string;
  udid: string;
  guestBridge: string;
  stateDir: string;
  derivedPath: string;
  limits: ResourceLimits;
  keepDevice: boolean;
}>;

export function parseConfig(argv: readonly string[]): SpikeConfig {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  if (args.some((argument) => argument === '--help' || argument === '-h')) {
    printHelp();
    process.exit(0);
  }
  const parsed = parseArguments(args);
  const udid = required(parsed.values, '--udid');
  const guestBridge = required(parsed.values, '--guest-bridge');
  const stateDir = createBenchmarkStateRoot();
  return {
    repoRoot: resolveRepoRoot(),
    udid,
    guestBridge,
    stateDir,
    derivedPath: path.join(stateDir, 'derived-data'),
    limits: DEFAULT_SPIKE_LIMITS,
    keepDevice: parsed.keepDevice,
  };
}

function parseArguments(args: readonly string[]): {
  values: ReadonlyMap<string, string>;
  keepDevice: boolean;
} {
  const values = new Map<string, string>();
  let keepDevice = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--keep-device') {
      keepDevice = true;
      continue;
    }
    assertValueFlag(flag);
    values.set(flag, readValue(args[index + 1], flag));
    index += 1;
  }
  return { values, keepDevice };
}

function assertValueFlag(flag: string | undefined): asserts flag is '--udid' | '--guest-bridge' {
  if (flag !== '--udid' && flag !== '--guest-bridge') {
    throw new SpikeConfigurationError(`Unknown option: ${String(flag)}`);
  }
}

function readValue(value: string | undefined, flag: string): string {
  if (!value || value.startsWith('--')) {
    throw new SpikeConfigurationError(`${flag} requires a value.`);
  }
  return value;
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (!value) throw new SpikeConfigurationError(`${flag} is required.`);
  return value;
}

function printHelp(): void {
  process.stdout.write(
    'Usage: pnpm bench:ios-ax-bridge:targeted -- --udid <simulator-udid> --guest-bridge <path> [--keep-device]\n',
  );
}
