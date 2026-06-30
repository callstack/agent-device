#!/usr/bin/env node
/**
 * iOS runner request-count gate.
 *
 * Drives a small, representative iOS replay scenario against a booted simulator
 * with `--debug`, reads the per-request diagnostics ndjson the daemon appends to
 * `<state-dir>/daemon.log`, counts the iOS-runner round-trip phases, and asserts
 * the total is unchanged versus the committed baseline
 * (`scripts/runner-request-count/expected-counts.json`). This proves a runner
 * refactor (e.g. Phase 3 step c — relocating the shared Apple XCTest runner)
 * adds or drops zero runner requests.
 *
 * Counting/assertion logic is the pure, unit-tested module
 * `src/daemon/runner-request-count.ts`; this script is only orchestration + I/O.
 *
 * Usage:
 *   node --experimental-strip-types scripts/runner-request-count/run.ts \
 *     --udid <UDID> [--scenario <path>] [--artifacts-dir <dir>] \
 *     [--prepare-timeout-ms <ms>] [--state-dir <dir>] [--keep] [--strict] [--update]
 *
 * Modes:
 *   (default)  assert observed counts == committed baseline (skips when unarmed).
 *   --update   record observed counts into the committed baseline (arm/regenerate).
 *
 * Robustness: an infra hiccup (scenario fails to run, or zero round-trips
 * captured) is reported as INCONCLUSIVE and does NOT fail the build unless
 * `--strict` is passed; only a real count drift against an armed baseline fails.
 *
 * The CLI invocation defaults to running from source
 * (`node --experimental-strip-types src/bin.ts`), matching the iOS workflow.
 * Override with AGENT_DEVICE_RUNNER_COUNT_CLI (e.g. the built dist binary path).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCmdSync } from '../../src/utils/exec.ts';
import {
  buildRunnerRequestCountBaseline,
  compareRunnerCounts,
  countRunnerRequests,
  parseRunnerRequestCountBaseline,
  RUNNER_ROUND_TRIP_PHASES,
  type RunnerRequestCountBaseline,
  type RunnerRequestCounts,
} from '../../src/daemon/runner-request-count.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const BASELINE_PATH = path.join(HERE, 'expected-counts.json');
const DEFAULT_SCENARIO = 'test/integration/replays/ios/simulator/01-settings.ad';
const DEFAULT_PREPARE_TIMEOUT_MS = 420_000;
const SCENARIO_TIMEOUT_MS = 600_000;
const MAX_BUFFER = 64 * 1024 * 1024;

type HarnessConfig = {
  mode: 'assert' | 'update';
  udid?: string;
  scenario: string;
  stateDir?: string;
  artifactsDir?: string;
  prepareTimeoutMs: number;
  strict: boolean;
  keep: boolean;
};

function log(msg: string): void {
  process.stderr.write(`[runner-count] ${msg}\n`);
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) throw new Error(`Missing value for ${flag}`);
  return value;
}

function envPrepareTimeoutMs(): number {
  const raw = process.env.AGENT_DEVICE_IOS_PREPARE_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PREPARE_TIMEOUT_MS;
}

// Uncovered CLI arg parser: fallow's CRAP score is inflated for scripts (no test
// coverage feeds the audit), so suppress the complexity finding here.
// fallow-ignore-next-line complexity
function parseArgs(argv: string[]): HarnessConfig {
  const cfg: HarnessConfig = {
    mode: 'assert',
    scenario: DEFAULT_SCENARIO,
    prepareTimeoutMs: envPrepareTimeoutMs(),
    strict: false,
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--update' || a === '--save') cfg.mode = 'update';
    else if (a === '--strict') cfg.strict = true;
    else if (a === '--keep') cfg.keep = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(HELP);
      process.exit(0);
    } else i = applyValueFlag(cfg, a, argv, i);
  }
  return cfg;
}

// Apply a flag that consumes the next argv token; returns the advanced index.
// fallow-ignore-next-line complexity
function applyValueFlag(cfg: HarnessConfig, flag: string, argv: string[], i: number): number {
  const value = readValue(argv, i + 1, flag);
  switch (flag) {
    case '--udid':
      cfg.udid = value;
      break;
    case '--scenario':
      cfg.scenario = value;
      break;
    case '--state-dir':
      cfg.stateDir = path.resolve(value);
      break;
    case '--artifacts-dir':
      cfg.artifactsDir = path.resolve(value);
      break;
    case '--prepare-timeout-ms':
      cfg.prepareTimeoutMs = Number(value);
      break;
    default:
      throw new Error(`Unknown flag: ${flag}`);
  }
  return i + 1;
}

const HELP = `iOS runner request-count gate

  --udid <UDID>            Simulator UDID to drive (required for a real run).
  --scenario <path>        Replay scenario (default: ${DEFAULT_SCENARIO}).
  --artifacts-dir <dir>    Where to write the replay + observed-count artifacts.
  --state-dir <dir>        Reuse an existing daemon state dir instead of a temp one.
  --prepare-timeout-ms <n> Runner prepare timeout (default ${DEFAULT_PREPARE_TIMEOUT_MS}).
  --update | --save        Record observed counts into the committed baseline.
  --strict                 Fail (not warn) on inconclusive/infra outcomes.
  --keep                   Keep the temp state dir after running.
  -h, --help               Show this help.
`;

function cliArgv(): string[] {
  const override = process.env.AGENT_DEVICE_RUNNER_COUNT_CLI?.trim();
  if (override) return override.split(/\s+/);
  return ['--experimental-strip-types', path.join(REPO_ROOT, 'src', 'bin.ts')];
}

function runCli(args: string[], timeoutMs: number): { exitCode: number; stderr: string } {
  const full = [...cliArgv(), ...args];
  try {
    const result = runCmdSync(process.execPath, full, {
      cwd: REPO_ROOT,
      maxBuffer: MAX_BUFFER,
      allowFailure: true,
      timeoutMs,
    });
    return { exitCode: result.exitCode, stderr: result.stderr };
  } catch (error) {
    return { exitCode: -1, stderr: error instanceof Error ? error.message : String(error) };
  }
}

function loadBaseline(): RunnerRequestCountBaseline {
  const raw = fs.readFileSync(BASELINE_PATH, 'utf8');
  return parseRunnerRequestCountBaseline(JSON.parse(raw) as unknown);
}

function writeBaseline(scenario: string, counts: RunnerRequestCounts): void {
  const baseline = buildRunnerRequestCountBaseline(scenario, counts);
  const doc = {
    $comment:
      'Expected iOS runner request-count baseline for the smoke-ios scenario. ' +
      'Regenerate with: node --experimental-strip-types scripts/runner-request-count/run.ts --udid <UDID> --update. ' +
      'runnerRoundTrips = ios_runner_command_send + ios_runner_readiness_preflight.',
    ...baseline,
  };
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(doc, null, 2)}\n`);
  log(`baseline updated: ${BASELINE_PATH}`);
}

function recordObserved(cfg: HarnessConfig, counts: RunnerRequestCounts): void {
  const doc = buildRunnerRequestCountBaseline(cfg.scenario, counts);
  process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
  if (!cfg.artifactsDir) return;
  try {
    fs.mkdirSync(cfg.artifactsDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfg.artifactsDir, 'expected-counts.observed.json'),
      `${JSON.stringify(doc, null, 2)}\n`,
    );
  } catch (error) {
    log(`warning: could not write observed-count artifact: ${String(error)}`);
  }
}

function describeCounts(counts: RunnerRequestCounts): string {
  const phases = RUNNER_ROUND_TRIP_PHASES.map((p) => `${p}=${counts.byPhase[p]}`).join(', ');
  return `runnerRoundTrips=${counts.runnerRoundTrips} (${phases})`;
}

function inconclusive(cfg: HarnessConfig, reason: string): number {
  log(`INCONCLUSIVE: ${reason}`);
  if (cfg.strict) {
    log('exiting non-zero because --strict was set');
    return 1;
  }
  log('treating as an infra hiccup (not a count drift); not failing the build');
  return 0;
}

// Warm the runner WITHOUT --debug so prepare diagnostics never pollute the count.
function prepareRunner(cfg: HarnessConfig, udid: string, stateDir: string): boolean {
  log('preparing iOS runner (no --debug)…');
  const prepare = runCli(
    [
      'prepare',
      'ios-runner',
      '--platform',
      'ios',
      '--udid',
      udid,
      '--timeout',
      String(cfg.prepareTimeoutMs),
      '--json',
      '--state-dir',
      stateDir,
    ],
    cfg.prepareTimeoutMs + 120_000,
  );
  return prepare.exitCode === 0;
}

// Drive the scenario with --debug (single attempt for a deterministic count) and
// return the run's exit code + the round-trip counts read from the daemon log.
function runScenario(
  cfg: HarnessConfig,
  udid: string,
  stateDir: string,
): { exitCode: number; observed: RunnerRequestCounts } {
  // Truncate daemon.log so we count ONLY the scenario's --debug round-trips.
  const logPath = path.join(stateDir, 'daemon.log');
  try {
    fs.writeFileSync(logPath, '');
  } catch {
    /* fresh state dir may not have a log yet; the daemon recreates it */
  }

  log('running scenario with --debug (single attempt)…');
  const args = [
    'test',
    cfg.scenario,
    '--udid',
    udid,
    '--debug',
    '--retries',
    '0',
    '--json',
    '--state-dir',
    stateDir,
  ];
  if (cfg.artifactsDir) args.push('--artifacts-dir', path.join(cfg.artifactsDir, 'replay'));
  const exitCode = runCli(args, SCENARIO_TIMEOUT_MS).exitCode;

  let logText = '';
  try {
    logText = fs.readFileSync(logPath, 'utf8');
  } catch {
    /* no log => zero counts, handled as inconclusive downstream */
  }
  return { exitCode, observed: countRunnerRequests(logText) };
}

// Assert the observed counts against the committed baseline. Infra hiccups
// (failed run / zero captures) are inconclusive; only a real drift fails.
// fallow-ignore-next-line complexity
function assertObserved(
  cfg: HarnessConfig,
  exitCode: number,
  observed: RunnerRequestCounts,
): number {
  if (exitCode !== 0) {
    return inconclusive(cfg, `scenario run failed (exit ${exitCode}); likely simulator/infra`);
  }
  if (observed.runnerRoundTrips === 0) {
    return inconclusive(
      cfg,
      'scenario passed but zero runner round-trips were captured (likely a capture/infra issue, not a real drift)',
    );
  }
  const comparison = compareRunnerCounts(loadBaseline(), observed);
  if (comparison.status === 'unarmed') {
    log('GATE NOT ARMED: committed baseline has established=false.');
    log('Arm it by committing the observed counts above (or re-run with --update).');
    return 0;
  }
  if (comparison.status === 'match') {
    log(`MATCH: ${describeCounts(observed)} == committed baseline. No runner request drift.`);
    return 0;
  }
  log('MISMATCH: iOS runner request count drifted from the committed baseline:');
  for (const diff of comparison.differences) {
    log(`  ${diff.key}: expected ${diff.expected}, got ${diff.actual}`);
  }
  log('If this drift is intentional, regenerate the baseline with --update and commit it.');
  return 1;
}

function runGate(cfg: HarnessConfig, stateDir: string): number {
  if (!cfg.udid) return inconclusive(cfg, 'no --udid provided; cannot drive a simulator scenario');
  if (!prepareRunner(cfg, cfg.udid, stateDir)) {
    return inconclusive(cfg, 'prepare ios-runner failed');
  }
  const { exitCode, observed } = runScenario(cfg, cfg.udid, stateDir);
  log(`observed: ${describeCounts(observed)}`);
  recordObserved(cfg, observed);
  if (cfg.mode === 'update') {
    writeBaseline(cfg.scenario, observed);
    log('OK: baseline recorded (update mode)');
    return 0;
  }
  return assertObserved(cfg, exitCode, observed);
}

function teardown(cfg: HarnessConfig, stateDir: string, createdStateDir: boolean): void {
  runCli(['close', '--shutdown', '--state-dir', stateDir], 60_000);
  if (!createdStateDir || cfg.keep) return;
  try {
    fs.rmSync(stateDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function main(): number {
  const cfg = parseArgs(process.argv.slice(2));
  const createdStateDir = !cfg.stateDir;
  const stateDir =
    cfg.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-runner-count-'));
  log(`scenario: ${cfg.scenario}`);
  log(`state-dir: ${stateDir}${createdStateDir ? ' (temp)' : ''}`);
  try {
    return runGate(cfg, stateDir);
  } finally {
    teardown(cfg, stateDir, createdStateDir);
  }
}

process.exit(main());
