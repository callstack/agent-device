// Layer 3 differential runner. Executes each scenario flow through BOTH real
// Maestro (`maestro test`) and agent-device (`replay`) on a live device and
// compares the observed outcomes. Opt-in: it needs a booted device/simulator,
// the `maestro` CLI on PATH, and an installed target app, so it runs only from
// the scheduled `conformance-differential` workflow or by hand.
//
//   node --experimental-strip-types scripts/maestro-conformance/differential/run.ts \
//     --platform ios --out-dir .tmp/conformance-differential
//
// `--dry-run` validates the scenario registry without a device (exercised by
// run.test.ts in unit CI, the same shape as help-conformance-bench).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DIFFERENTIAL_SCENARIOS,
  type DifferentialScenario,
  type DivergenceSignature,
} from './scenarios.ts';
import { type InvariantResult, evaluateInvariants, readTrace } from './invariants.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFORMANCE_DIR = path.resolve(HERE, '..');

export type RunnerOptions = {
  platform?: string;
  outDir?: string;
  /** Artifacts root to search for agent-device's replay-timing.ndjson. */
  traceRoot?: string;
  dryRun: boolean;
  only?: string;
  maestroBin: string;
  agentDeviceCli: string;
};

export function parseRunnerArgs(argv: readonly string[]): RunnerOptions {
  const options: RunnerOptions = {
    dryRun: false,
    maestroBin: process.env.MAESTRO_BIN ?? 'maestro',
    // Mirror the perf harness convention (AGENT_DEVICE_PERF_CLI).
    agentDeviceCli: process.env.AGENT_DEVICE_CLI ?? '--experimental-strip-types src/bin.ts',
    traceRoot: process.env.AGENT_DEVICE_ARTIFACTS_DIR,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--platform') options.platform = argv[(i += 1)];
    else if (arg === '--out-dir') options.outDir = argv[(i += 1)];
    else if (arg === '--trace-root') options.traceRoot = argv[(i += 1)];
    else if (arg === '--only') options.only = argv[(i += 1)];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export function selectScenarios(only?: string): DifferentialScenario[] {
  if (!only) return DIFFERENTIAL_SCENARIOS;
  const selected = DIFFERENTIAL_SCENARIOS.filter((scenario) => scenario.id === only);
  if (selected.length === 0) throw new Error(`No scenario named ${only}`);
  return selected;
}

/** Validate the registry without a device: flows exist, ids are unique. */
export function validateScenarios(): void {
  const ids = new Set<string>();
  for (const scenario of DIFFERENTIAL_SCENARIOS) {
    if (ids.has(scenario.id)) throw new Error(`Duplicate scenario id: ${scenario.id}`);
    ids.add(scenario.id);
    const flowPath = path.join(CONFORMANCE_DIR, scenario.flow);
    if (!fs.existsSync(flowPath)) throw new Error(`Scenario ${scenario.id} flow not found: ${scenario.flow}`);
  }
}

type EngineResult = { engine: 'maestro' | 'agent-device'; outcome: 'pass' | 'fail'; exitCode: number };

function runEngine(
  engine: EngineResult['engine'],
  command: string,
  args: string[],
): EngineResult {
  const [bin = '', ...rest] = command.split(' ').filter(Boolean);
  const result = spawnSync(bin, [...rest, ...args], { stdio: 'inherit', cwd: process.cwd() });
  const exitCode = result.status ?? 1;
  return { engine, outcome: exitCode === 0 ? 'pass' : 'fail', exitCode };
}

export type ScenarioReport = {
  id: string;
  flow: string;
  maestro: EngineResult;
  agentDevice: EngineResult;
  /** Outcome parity across the two engines. */
  outcomeDiverged: boolean;
  /** Engine-side invariants over agent-device's own timing trace. */
  invariants: InvariantResult[];
  /**
   * ok                  — behaved as expected.
   * failed              — an UNDECLARED divergence. The signal this exists for.
   * known-divergence    — failed exactly as declared; tracked, so the run stays green.
   * stale-declaration   — passed while still declared divergent: remove the
   *                       declaration (the gap is closed). Fails, so a fix cannot
   *                       land while leaving the oracle blind to a regression.
   */
  status: 'ok' | 'failed' | 'known-divergence' | 'stale-declaration';
  tracking?: string;
  failed: boolean;
};

/**
 * Locate the timing trace agent-device wrote for this run. The test runtime
 * writes `replay-timing.ndjson` under the run's artifacts directory; we take the
 * most recent one so nested attempt-N directories resolve correctly.
 */
function findTimingTrace(root: string | undefined): string | undefined {
  if (!root || !fs.existsSync(root)) return undefined;
  const found: Array<{ file: string; mtimeMs: number }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'replay-timing.ndjson') {
        found.push({ file: full, mtimeMs: fs.statSync(full).mtimeMs });
      }
    }
  };
  walk(root);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file;
}

/**
 * Does the observed failure match the one the waiver was granted for, exactly?
 * Both engines' outcomes and every declared invariant status must line up; any
 * deviation means this is a different failure and must stay red.
 */
export function matchesSignature(
  expected: DivergenceSignature,
  maestro: EngineResult,
  agentDevice: EngineResult,
  invariants: InvariantResult[],
): boolean {
  if (maestro.outcome !== expected.maestro) return false;
  if (agentDevice.outcome !== expected.agentDevice) return false;
  const expectedInvariants = expected.invariants ?? [];
  if (expectedInvariants.length !== invariants.length) return false;
  return expectedInvariants.every((status, index) => invariants[index]?.status === status);
}

function runScenario(scenario: DifferentialScenario, options: RunnerOptions): ScenarioReport {
  const flowPath = path.join(CONFORMANCE_DIR, scenario.flow);
  const platformArgs = options.platform ? ['--platform', options.platform] : [];

  const maestro = runEngine('maestro', options.maestroBin, ['test', flowPath, ...platformArgs]);
  // `--maestro` is required: without it `test` rejects a .yaml flow outright
  // ("test does not support this file type"). Matches scripts/run-test-app-maestro-suite.mjs.
  const agentDevice = runEngine('agent-device', `node ${options.agentDeviceCli}`, [
    'test',
    flowPath,
    '--maestro',
    ...platformArgs,
  ]);

  const outcomeDiverged =
    maestro.outcome !== scenario.expect || agentDevice.outcome !== scenario.expect;

  // Outcome parity cannot see settle ordering or timing; assert engine-side
  // invariants over agent-device's own trace where the scenario declares them.
  const trace = findTimingTrace(options.traceRoot);
  const invariants = scenario.engineInvariants
    ? evaluateInvariants(trace ? readTrace(trace) : [], scenario.engineInvariants)
    : [];
  const invariantFailed = invariants.some((result) => result.status !== 'held');
  const misbehaved = outcomeDiverged || invariantFailed;

  // A declared divergence is an expected, tracked gap: it keeps the run green so
  // the oracle is not blocked on the engine bug it just found. But the waiver
  // covers ONE precise failure — matched exactly below — so while the gap is
  // open the job still catches anything else (upstream regressing, a different
  // invariant breaking). And a declaration that no longer reproduces FAILS, so
  // the fix PR has to delete it; that is what turns the differential into the
  // acceptance test for its own findings.
  const declared = scenario.knownDivergence;
  const matchesDeclared =
    declared !== undefined && matchesSignature(declared.expected, maestro, agentDevice, invariants);
  const status = !declared
    ? misbehaved
      ? ('failed' as const)
      : ('ok' as const)
    : matchesDeclared
      ? ('known-divergence' as const)
      : misbehaved
        ? // Diverged, but not the way the waiver describes: not covered.
          ('failed' as const)
        : ('stale-declaration' as const);

  return {
    id: scenario.id,
    flow: scenario.flow,
    maestro,
    agentDevice,
    outcomeDiverged,
    invariants,
    status,
    ...(declared ? { tracking: declared.tracking } : {}),
    failed: status === 'failed' || status === 'stale-declaration',
  };
}

function main(argv: readonly string[]): void {
  const options = parseRunnerArgs(argv);
  validateScenarios();
  const scenarios = selectScenarios(options.only);

  if (options.dryRun) {
    for (const scenario of scenarios) {
      const invariants = scenario.engineInvariants?.length ?? 0;
      const declared = scenario.knownDivergence
        ? `\tdeclared-divergence=${scenario.knownDivergence.tracking}`
        : '';
      console.log(
        `${scenario.id}\t${scenario.flow}\texpect=${scenario.expect}\tinvariants=${invariants}${declared}`,
      );
    }
    const known = scenarios.filter((scenario) => scenario.knownDivergence).length;
    console.log(`\n${scenarios.length} scenario(s) validated, ${known} declared divergence(s).`);
    return;
  }

  const reports = scenarios.map((scenario) => runScenario(scenario, options));
  if (options.outDir) {
    fs.mkdirSync(options.outDir, { recursive: true });
    fs.writeFileSync(
      path.join(options.outDir, 'differential-report.json'),
      `${JSON.stringify({ platform: options.platform, reports }, null, 2)}\n`,
    );
  }

  for (const report of reports) {
    console.log(
      `${report.status.padEnd(17)} ${report.id} maestro=${report.maestro.outcome} agent-device=${report.agentDevice.outcome}`,
    );
    for (const result of report.invariants) {
      console.log(`        invariant ${result.status}: ${result.detail}`);
    }
    if (report.status === 'known-divergence') {
      console.log(`        declared divergence, tracked: ${report.tracking}`);
    }
    if (report.status === 'stale-declaration') {
      console.log(
        `        passed while declared divergent — remove knownDivergence (${report.tracking}) so this stays enforced`,
      );
    }
  }

  // Keep declared gaps visible: a green run must still say what it is not proving.
  const known = reports.filter((report) => report.status === 'known-divergence');
  if (known.length > 0) {
    console.log(`\n${known.length} declared divergence(s), not enforced: ${known.map((r) => r.id).join(', ')}`);
  }

  const failed = reports.filter((report) => report.failed);
  if (failed.length > 0) {
    console.error(`\n${failed.length} scenario(s) failed: ${failed.map((r) => r.id).join(', ')}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
