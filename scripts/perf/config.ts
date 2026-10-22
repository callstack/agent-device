import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Platform } from './types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
const CLI_BIN = path.join(REPO_ROOT, 'bin', 'agent-device.mjs');
const DEFAULT_OUT_DIR = path.join(HERE, '.results');

export type PerfConfig = {
  platform: Platform;
  rounds: number; // measured rounds (samples per command)
  warmup: number; // leading rounds dropped from stats
  keepArtifacts: boolean; // keep temp state dir + leave device booted
  outDir: string;
  udid?: string; // iOS simulator UDID (required for iOS)
  device?: string; // Android AVD name for boot
  serial?: string; // Android device override
  appId: string; // iOS fixture bundle id
  appPath?: string; // iOS fixture bundle path, recorded in the run metadata
  scenarios?: string[]; // iOS scenario ids; all when omitted
};

export const DEFAULT_IOS_APP_ID = 'com.callstack.agentdevicelab';

/** The fewest measured rounds that a run accepts; a comparison needs as many successful samples. */
export const MIN_MEASURED_ROUNDS = 3;

// How to invoke the CLI. Defaults to the built dist binary (bin/agent-device.mjs).
// Set AGENT_DEVICE_PERF_CLI to run from source instead, e.g. on CI:
//   AGENT_DEVICE_PERF_CLI="--experimental-strip-types src/bin.ts"
// (matches the device workflows, which run from source and skip the dist build).
export function resolveCliArgv(): string[] {
  const override = process.env.AGENT_DEVICE_PERF_CLI?.trim();
  if (override) return override.split(/\s+/);
  return [CLI_BIN];
}

export function usesSourceCli(): boolean {
  return Boolean(process.env.AGENT_DEVICE_PERF_CLI?.trim());
}

function readValue(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined) throw new Error(`Missing value for ${flag}`);
  return v;
}

function readIntValue(argv: string[], i: number, flag: string, min: number): number {
  const raw = readValue(argv, i, flag);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${flag} must be an integer >= ${min} (got ${JSON.stringify(raw)})`);
  }
  return n;
}

export function parseConfig(argv: string[]): PerfConfig {
  const cfg: PerfConfig = {
    platform: 'ios',
    rounds: MIN_MEASURED_ROUNDS,
    warmup: 1,
    keepArtifacts: false,
    outDir: path.join(DEFAULT_OUT_DIR, new Date().toISOString().replaceAll(/[:.]/g, '-')),
    appId: DEFAULT_IOS_APP_ID,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--platform': {
        const v = readValue(argv, i++, a);
        if (v !== 'ios' && v !== 'android') throw new Error(`Unknown platform: ${v}`);
        cfg.platform = v;
        break;
      }
      case '--n':
      case '--rounds':
        cfg.rounds = readIntValue(argv, i++, a, MIN_MEASURED_ROUNDS);
        break;
      case '--warmup':
        cfg.warmup = readIntValue(argv, i++, a, 0);
        break;
      case '--keep-artifacts':
        cfg.keepArtifacts = true;
        break;
      case '--out-dir':
        cfg.outDir = path.resolve(readValue(argv, i++, a));
        break;
      case '--udid':
        cfg.udid = readValue(argv, i++, a);
        break;
      case '--device':
        cfg.device = readValue(argv, i++, a);
        break;
      case '--serial':
        cfg.serial = readValue(argv, i++, a);
        break;
      case '--app-id':
        cfg.appId = readValue(argv, i++, a);
        break;
      case '--app-path':
        cfg.appPath = path.resolve(readValue(argv, i++, a));
        break;
      case '--scenarios':
        cfg.scenarios = readValue(argv, i++, a)
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean);
        break;
      default:
        throw new Error(`Unknown flag: ${a}`);
    }
  }
  if (cfg.platform === 'ios' && !cfg.udid) throw new Error('--udid is required for --platform ios');
  return cfg;
}
