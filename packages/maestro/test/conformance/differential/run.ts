// Layer 3 differential runner. Executes each scenario flow through BOTH real
// Maestro (`maestro test`) and agent-device (`replay`) on a live device and
// compares the observed outcomes. Opt-in: it needs a booted device/simulator,
// the `maestro` CLI on PATH, and an installed target app, so it runs only from
// the scheduled `conformance-differential` workflow or by hand.
//
//   node --experimental-strip-types packages/maestro/test/conformance/differential/run.ts \
//     --platform ios --out-dir .tmp/conformance-differential
//
// `--dry-run` validates the scenario registry without a device (exercised by
// run.test.ts in unit CI, the same shape as help-conformance-bench).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DIFFERENTIAL_SCENARIOS,
  type DifferentialScenario,
  type DivergenceSignature,
} from './scenarios.ts';
import { type InvariantResult, evaluateInvariants, readTrace } from './invariants.ts';
import { type EngineResult, runAgentDeviceEngine, runMaestroEngine } from './engine-process.ts';
import {
  printDryRun,
  printRunSummary,
  printScenarioReport,
  type ScenarioReport,
  writeReports,
} from './report-output.ts';

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
    if (!fs.existsSync(flowPath))
      throw new Error(`Scenario ${scenario.id} flow not found: ${scenario.flow}`);
  }
}

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
  if (maestro.failureKind === 'infrastructure' || agentDevice.failureKind === 'infrastructure')
    return false;
  if (maestro.outcome !== expected.maestro) return false;
  if (agentDevice.outcome !== expected.agentDevice) return false;
  const expectedInvariants = expected.invariants ?? [];
  if (expectedInvariants.length !== invariants.length) return false;
  return expectedInvariants.every((status, index) => invariants[index]?.status === status);
}

function resolveScenarioStatus(input: {
  infrastructureFailed: boolean;
  declared: boolean;
  matchesDeclared: boolean;
  misbehaved: boolean;
}): ScenarioReport['status'] {
  if (input.infrastructureFailed) return 'infrastructure-failed';
  if (!input.declared) return input.misbehaved ? 'failed' : 'ok';
  if (input.matchesDeclared) return 'known-divergence';
  return input.misbehaved ? 'failed' : 'stale-declaration';
}

const FAILED_SCENARIO_STATUSES = new Set<ScenarioReport['status']>([
  'failed',
  'infrastructure-failed',
  'stale-declaration',
]);

function evaluateScenarioInvariants(
  scenario: DifferentialScenario,
  traceRoot: string | undefined,
): InvariantResult[] {
  if (!scenario.engineInvariants) return [];
  const trace = findTimingTrace(traceRoot);
  return evaluateInvariants(trace ? readTrace(trace) : [], scenario.engineInvariants);
}

function matchesDeclaredDivergence(
  scenario: DifferentialScenario,
  maestro: EngineResult,
  agentDevice: EngineResult,
  invariants: InvariantResult[],
): boolean {
  const declaration = scenario.knownDivergence;
  return declaration
    ? matchesSignature(declaration.expected, maestro, agentDevice, invariants)
    : false;
}

export function runScenario(
  scenario: DifferentialScenario,
  options: RunnerOptions,
): ScenarioReport {
  const flowPath = path.join(CONFORMANCE_DIR, scenario.flow);
  const platformArgs = options.platform ? ['--platform', options.platform] : [];

  const maestro = runMaestroEngine(options.maestroBin, ['test', flowPath, ...platformArgs]);
  // `--maestro` is required: without it `test` rejects a .yaml flow outright
  // ("test does not support this file type"). Matches scripts/run-test-app-maestro-suite.mjs.
  const agentDevice = runAgentDeviceEngine(options.agentDeviceCli, [
    'test',
    flowPath,
    '--maestro',
    ...platformArgs,
  ]);

  const outcomeDiverged =
    maestro.outcome !== scenario.expect || agentDevice.outcome !== scenario.expect;

  // Outcome parity cannot see settle ordering or timing; assert engine-side invariants too.
  const invariants = evaluateScenarioInvariants(scenario, options.traceRoot);
  const invariantFailed = invariants.some((result) => result.status !== 'held');
  const misbehaved = outcomeDiverged || invariantFailed;
  const infrastructureFailed =
    maestro.failureKind === 'infrastructure' || agentDevice.failureKind === 'infrastructure';

  // A declared divergence is an expected, tracked gap: it keeps the run green so
  // the oracle is not blocked on the engine bug it just found. But the waiver
  // covers ONE precise failure — matched exactly below — so while the gap is
  // open the job still catches anything else (upstream regressing, a different
  // invariant breaking). And a declaration that no longer reproduces FAILS, so
  // the fix PR has to delete it; that is what turns the differential into the
  // acceptance test for its own findings.
  const declared = scenario.knownDivergence;
  const matchesDeclared = matchesDeclaredDivergence(scenario, maestro, agentDevice, invariants);
  const status = resolveScenarioStatus({
    infrastructureFailed,
    declared: declared !== undefined,
    matchesDeclared,
    misbehaved,
  });

  return {
    id: scenario.id,
    flow: scenario.flow,
    maestro,
    agentDevice,
    outcomeDiverged,
    invariants,
    status,
    ...(declared ? { tracking: declared.tracking } : {}),
    failed: FAILED_SCENARIO_STATUSES.has(status),
  };
}

function main(argv: readonly string[]): void {
  const options = parseRunnerArgs(argv);
  validateScenarios();
  const scenarios = selectScenarios(options.only);

  if (options.dryRun) {
    printDryRun(scenarios);
    return;
  }

  const reports = scenarios.map((scenario) => runScenario(scenario, options));
  writeReports(options.outDir, options.platform, reports);
  for (const report of reports) {
    printScenarioReport(report);
  }
  printRunSummary(reports);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
