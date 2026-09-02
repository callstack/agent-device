import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { SpikeCell, SpikeReport, SpikeSample } from './types.ts';

export function writeSpikeReport(outputPath: string, report: SpikeReport): void {
  const compact = compactReportEvidence(report);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, gzipSync(`${JSON.stringify(compact)}\n`, { level: 9 }));
  fs.writeFileSync(markdownPath(outputPath), renderSpikeMarkdown(compact));
}

export function markdownPath(outputPath: string): string {
  const replaced = outputPath.replace(/\.json(?:\.gz)?$/u, '.md');
  return replaced === outputPath ? `${outputPath}.md` : replaced;
}

function renderSpikeMarkdown(report: SpikeReport): string {
  const lines = [
    '# iOS Simulator AX bridge spike',
    '',
    `- Decision: **${report.decision}**`,
    `- Status: **${report.status}**`,
    `- Revision: ${report.revision.commit} (${report.revision.branch})`,
    `- Target: ${report.target.name} (${report.target.udid}, ${report.target.runtime})`,
    `- Generated: ${report.generatedAt}`,
    `- Corpus: states=${report.config.states.join(', ')}, screens=${report.config.screens.join(', ')}, samples=${report.config.requestedSamples}`,
    `- Corpus coverage: **${report.corpusCoverage}**`,
    '',
    '## Evaluated guest mechanism',
    '',
    `- Implementation: **${report.guestMechanism.implementation} ${report.guestMechanism.release}** using \`${report.guestMechanism.backend}\` and \`${report.guestMechanism.outputFormat}\` output.`,
    `- Companion: \`${report.guestMechanism.companionArchive}\` (SHA-256 \`${report.guestMechanism.companionSha256}\`).`,
    `- CLI: \`${report.guestMechanism.cliArchive}\` (SHA-256 \`${report.guestMechanism.cliSha256}\`).`,
    `- Host client: **${report.guestMechanism.client}**; the companion and client remain outside the distributed package.`,
    '',
    '## Environment and limits',
    '',
    ...environmentLines(report),
    '',
    '## Candidate fidelity and limitation matrix',
    '',
    '| Candidate | Mechanism | App surface | System surface | Lifecycle | Main limitation |',
    '|---|---|---|---|---|---|',
    `| guest-simulator-framework-bridge | idb SimulatorFrameworkBridge guest via axbridge-persistent | ${surfaceStatus(report, 'guest-simulator-framework-bridge', 'app')} | ${surfaceStatus(report, 'guest-simulator-framework-bridge', 'system')} | persistent companion + typed reader | provider exposes a flat raw element response |`,
    `| xctest-control | #2189 XCTest runner control | ${surfaceStatus(report, 'xctest-control', 'app')} | ${surfaceStatus(report, 'xctest-control', 'system')} | existing runner lifecycle | control, not a host-side AX bridge |`,
    '',
    '## Raw acquisition and prototype presentation results',
    '',
    '| Candidate | State | Screen | Readable/attempted | Wall p50/p95 ms | Gated duration p50/p95 ms | First look p95 ms | Presentation p50/p95 ms | Nodes | Failures |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---:|',
    ...report.cells.map(renderCellRow),
    '',
    ...fidelityLines(report),
    '',
    'Every acquisition sample retains timing, resource, readiness, and failure evidence; the first successful sample in each cell also retains one raw node-tree exemplar with viewport, target generation, truncation, and residue. Presentation samples measure only construction of the #2190 acquired carrier; they do not apply visibility, hittability, scope, depth, or semantic compaction.',
    '',
    '## Direct protocol probes',
    '',
    ...probeLines(report),
    '',
    '## Independent positive-control evidence',
    '',
    `- Invalid shallow rule: exit=${report.positiveControl.invalidShallowRule.exitCode}; command=${report.positiveControl.invalidShallowRule.command}; assertion=${report.positiveControl.invalidShallowRule.assertion}`,
    `- Safe full rule: exit=${report.positiveControl.safeFullRule.exitCode}; command=${report.positiveControl.safeFullRule.command}; assertion=${report.positiveControl.safeFullRule.assertion}`,
    '',
    '## Preference experiment',
    '',
    `- Applied: **${report.preferenceEvidence.applied}**`,
    `- Restored: **${report.preferenceEvidence.applied ? report.preferenceEvidence.restored : 'not required'}**`,
    `- Fixture launch compatible: **${report.preferenceEvidence.fixtureLaunchCompatible ?? 'not exercised'}**`,
    `- Simulator state before experiment: ${report.preferenceEvidence.simulatorStateBefore}`,
    preferenceExperimentLine(report),
    ...preferenceLines(report),
    '',
    '## Lifecycle, cancellation, and recovery',
    '',
    `- Source: ${report.lifecycle.source}`,
    `- Process crash: ${report.lifecycle.crash.failure}; recovered=${report.lifecycle.crash.recovered}`,
    `- Timeout: ${report.lifecycle.timeout.failure}; recovered=${report.lifecycle.timeout.recovered}`,
    `- Cancellation: ${report.lifecycle.cancellation.failure}; recovered=${report.lifecycle.cancellation.recovered}`,
    `- Stale generation: ${report.lifecycle.staleGeneration.failure}; recovered=${report.lifecycle.staleGeneration.recovered}`,
    '',
    '## Decision rationale',
    '',
    ...report.decisionReasons.map((reason) => `- ${reason}`),
    '',
    '## Next interface boundary',
    '',
    `- ${report.nextInterface}`,
    '',
    '## Production boundary',
    '',
    '- No production backend selection, fallback, runner-demand, open/relaunch, proxy, XCTest interaction, or public CLI changes were made.',
    '- A production bridge should not start until this report has a GO result; this run is the #2192 boundary.',
  ];
  if (report.stop) {
    lines.push('', '## Stop condition', '', `- ${report.stop.category}: ${report.stop.message}`);
    if (report.stop.command) lines.push(`- Command: ${report.stop.command}`);
  }
  return `${lines.join('\n')}\n`;
}

function environmentLines(report: SpikeReport): string[] {
  return [
    `- Node: ${report.toolchain.node}`,
    `- pnpm: ${report.toolchain.pnpm}`,
    `- Xcode: ${report.toolchain.xcode.replaceAll('\n', '; ')}`,
    `- simctl: ${report.toolchain.simctl}`,
    `- OS: ${report.toolchain.os}; arch=${report.toolchain.arch}`,
    `- Bounds: request=${report.limits.maxRequestBytes} B, response=${report.limits.maxResponseBytes} B, nodes=${report.limits.maxNodes}, traversal=${report.limits.maxTraversalDepth}, CPU=${report.limits.maxCpuMs} ms, memory=${report.limits.maxMemoryBytes} B, duration=${report.limits.maxDurationMs} ms`,
  ];
}

function probeLines(report: SpikeReport): string[] {
  const lines: string[] = [];
  for (const probe of report.protocolProbes) {
    lines.push(renderProbeLine(probe));
  }
  for (const log of report.protocolProbeLogs) {
    lines.push(renderProbeLog(log));
  }
  return lines;
}

function renderProbeLine(probe: SpikeReport['protocolProbes'][number]): string {
  return `- ${probe.candidate}/${probe.id}: ok=${probe.ok}, failure=${failureValue(probe.failure, 'kind')}, code=${failureValue(probe.failure, 'code')}, nodes=${probe.metrics.nodeCount}, duration=${probe.metrics.durationMs.toFixed(1)} ms, CPU=${metricValue(probe.metrics.cpuMs)} ms, memory=${probe.metrics.memoryBytes ?? '–'} B, response=${probe.metrics.responseBytes} B`;
}

function renderProbeLog(log: SpikeReport['protocolProbeLogs'][number]): string {
  return `- stderr ${log.candidate}/${log.id}: ${log.stderr.trim().replaceAll('\n', ' ⏎ ') || 'empty'}`;
}

function failureValue(
  failure: SpikeReport['protocolProbes'][number]['failure'],
  key: 'kind' | 'code',
): string {
  return failure?.[key] ?? 'none';
}

function metricValue(value: number | null): string {
  return value === null ? '–' : value.toFixed(1);
}

function renderCellRow(cell: SpikeCell): string {
  const acquisition = cell.acquisitionSamples;
  const presentation = cell.presentationSamples;
  const readable = acquisition.filter((sample) => sample.ok && sample.firstTree === 'readable');
  const failures = acquisition.length - readable.length;
  const nodeCounts = readable.flatMap((sample) =>
    typeof sample.metrics?.nodeCount === 'number' ? [sample.metrics.nodeCount] : [],
  );
  return `| ${cell.candidate} | ${cell.state} | ${cell.screen} | ${readable.length}/${acquisition.length} | ${summary(readable, 'wallClockMs')} | ${metricSummary(readable)} | ${summary(readable, 'firstLookMs')} | ${summary(
    presentation.filter((sample) => sample.ok),
    'wallClockMs',
  )} | ${formatNumber(median(nodeCounts))} | ${failures} |`;
}

function metricSummary(samples: readonly SpikeSample[]): string {
  const values = samples.flatMap((sample) =>
    sample.metrics && Number.isFinite(sample.metrics.durationMs) ? [sample.metrics.durationMs] : [],
  );
  return values.length === 0
    ? '–'
    : `${formatNumber(median(values))}/${formatNumber(percentile(values, 95))}`;
}

function surfaceStatus(
  report: SpikeReport,
  candidate: SpikeCell['candidate'],
  surface: 'app' | 'system',
): string {
  const cells = report.cells.filter(
    (cell) =>
      cell.candidate === candidate &&
      (surface === 'system' ? cell.screen === 'system-surface' : cell.screen !== 'system-surface'),
  );
  if (cells.some((cell) => cell.acquisitionSamples.some((sample) => sample.ok))) {
    return 'observed in successful cells';
  }
  if (cells.length > 0) return 'failed in cells';
  const probe = report.protocolProbes.find((item) => item.candidate === candidate);
  if (probe?.failure?.kind === 'unsupported-mechanism') return 'unsupported before corpus';
  if (report.candidates.includes(candidate)) return 'not exercised';
  return 'not selected';
}

function preferenceLines(report: SpikeReport): string[] {
  return report.preferenceEvidence.diffs.flatMap((diff) => [
    `- ${diff.path}: existed=${diff.existedBefore}, beforeSha256=${diff.beforeSha256 ?? 'missing'}, afterSha256=${diff.afterSha256 ?? 'missing'}`,
    `  - Changes: ${diff.changes.length === 0 ? 'none' : diff.changes.map((change) => `${change.key}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`).join('; ')}`,
  ]);
}

function preferenceExperimentLine(report: SpikeReport): string {
  return report.preferenceEvidence.applied && report.preferenceEvidence.restored
    ? '- Private/preboot preference keys are experimental only; they were applied to this shutdown disposable Simulator and the original plist bytes were restored.'
    : report.preferenceEvidence.applied
      ? '- Private/preboot preference keys were applied, but restoration was not proven.'
      : '- No private/preboot preference keys were applied in this run.';
}

function compactReportEvidence(report: SpikeReport): SpikeReport {
  return {
    ...report,
    cells: report.cells.map((cell) => ({
      ...cell,
      acquisitionSamples: cell.acquisitionSamples.map((sample, index) =>
        index === 0 || !sample.ok || sample.stderr === undefined ? sample : withoutStderr(sample),
      ),
      presentationSamples: cell.presentationSamples.map((sample) => withoutStderr(sample)),
    })),
  };
}

function withoutStderr(sample: SpikeSample): SpikeSample {
  const { stderr: _stderr, ...rest } = sample;
  return rest;
}

function fidelityLines(report: SpikeReport): string[] {
  const candidate = 'guest-simulator-framework-bridge';
  const comparisons = report.config.screens.flatMap((screen) =>
    fidelityComparison(report, candidate, screen),
  );
  if (comparisons.length > 0) {
    return ['Raw exemplar fidelity (candidate vs XCTest control):', ...comparisons];
  }
  return report.candidates.includes(candidate)
    ? [`- ${candidate}: no comparable raw exemplar was produced.`]
    : ['Raw exemplar fidelity comparison was not available.'];
}

function fidelityComparison(
  report: SpikeReport,
  candidate: SpikeCell['candidate'],
  screen: SpikeCell['screen'],
): readonly string[] {
  const candidateSample = exemplarSample(report, candidate, screen);
  const controlSample = exemplarSample(report, 'xctest-control', screen);
  if (!candidateSample?.acquisition || !controlSample?.acquisition) return [];
  const candidateNodes = candidateSample.acquisition.nodes;
  const controlNodes = controlSample.acquisition.nodes;
  const candidateIdentifiers = candidateNodes.filter((node) => node.identifier).length;
  const controlIdentifiers = controlNodes.filter((node) => node.identifier).length;
  return [
    `- ${candidate} ${screen}: nodes ${candidateNodes.length}/${controlNodes.length}; depth ${candidateSample.metrics?.maxTraversalDepth ?? '–'}/${controlSample.metrics?.maxTraversalDepth ?? '–'}; identifiers ${candidateIdentifiers}/${controlIdentifiers}.`,
  ];
}

function exemplarSample(
  report: SpikeReport,
  candidate: SpikeCell['candidate'],
  screen: SpikeCell['screen'],
): SpikeSample | undefined {
  return report.cells
    .find((cell) => cell.candidate === candidate && cell.screen === screen)
    ?.acquisitionSamples.find((sample) => sample.acquisition);
}

function summary(samples: readonly SpikeSample[], key: 'wallClockMs' | 'firstLookMs'): string {
  const values = samples.flatMap((sample) => {
    const value = sample[key];
    return typeof value === 'number' && Number.isFinite(value) ? [value] : [];
  });
  if (values.length === 0) return '–';
  return `${formatNumber(median(values))}/${formatNumber(percentile(values, 95))}`;
}

function median(values: readonly number[]): number {
  return percentile(values, 50);
}

export function percentile(values: readonly number[], percentage: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((percentage / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '–';
}
