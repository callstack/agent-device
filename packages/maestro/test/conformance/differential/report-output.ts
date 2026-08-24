import fs from 'node:fs';
import path from 'node:path';
import type { EngineResult } from './engine-process.ts';
import type { InvariantResult } from './invariants.ts';
import type { DifferentialScenario } from './scenarios.ts';

export type ScenarioReport = {
  id: string;
  flow: string;
  maestro: EngineResult;
  agentDevice: EngineResult;
  outcomeDiverged: boolean;
  invariants: InvariantResult[];
  status: 'ok' | 'failed' | 'infrastructure-failed' | 'known-divergence' | 'stale-declaration';
  tracking?: string;
  failed: boolean;
};

export function printScenarioReport(report: ScenarioReport): void {
  console.log(
    `${report.status.padEnd('infrastructure-failed'.length)} ${report.id} maestro=${report.maestro.outcome} agent-device=${report.agentDevice.outcome}`,
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
  if (report.status === 'infrastructure-failed') {
    console.log('        oracle did not complete because engine infrastructure failed');
  }
}

export function printDryRun(scenarios: DifferentialScenario[]): void {
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
}

export function writeReports(
  outDir: string | undefined,
  platform: string | undefined,
  reports: ScenarioReport[],
): void {
  if (!outDir) return;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'differential-report.json'),
    `${JSON.stringify({ platform, reports }, null, 2)}\n`,
  );
}

export function printRunSummary(reports: ScenarioReport[]): void {
  const known = reports.filter((report) => report.status === 'known-divergence');
  if (known.length > 0) {
    console.log(
      `\n${known.length} declared divergence(s), not enforced: ${known.map((r) => r.id).join(', ')}`,
    );
  }
  const failed = reports.filter((report) => report.failed);
  if (failed.length === 0) return;
  console.error(`\n${failed.length} scenario(s) failed: ${failed.map((r) => r.id).join(', ')}`);
  process.exitCode = 1;
}
