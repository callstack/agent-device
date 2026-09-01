import fs from 'node:fs';
import path from 'node:path';
import type { SpikeCell, SpikeReport, SpikeSample } from './types.ts';

export function writeSpikeReport(outputPath: string, report: SpikeReport): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(outputPath.replace(/\.json$/u, '.md'), renderSpikeMarkdown(report));
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
    '',
    '## Environment and limits',
    '',
    ...environmentLines(report),
    '',
    '## Candidate fidelity and limitation matrix',
    '',
    '| Candidate | Mechanism | App surface | System surface | Lifecycle | Main limitation |',
    '|---|---|---|---|---|---|',
    `| public-macos-ax | public macOS ApplicationServices AX | ${surfaceStatus(report, 'public-macos-ax', 'app')} | ${surfaceStatus(report, 'public-macos-ax', 'system')} | framed protocol | host Accessibility permission and whole-Simulator process-tree breadth |`,
    `| private-coresimulator-ax | external/private CoreSimulator AX tool | ${surfaceStatus(report, 'private-coresimulator-ax', 'app')} | ${surfaceStatus(report, 'private-coresimulator-ax', 'system')} | framed protocol contract only | private interface/tool compatibility |`,
    `| xctest-control | #2189 XCTest runner control | ${surfaceStatus(report, 'xctest-control', 'app')} | ${surfaceStatus(report, 'xctest-control', 'system')} | existing runner lifecycle | control, not a host-side AX bridge |`,
    '',
    '## Raw acquisition and prototype presentation results',
    '',
    '| Candidate | State | Screen | N | Acquisition p50/p95 ms | First look p95 ms | Presentation p50/p95 ms | Nodes | Failures |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|',
    ...report.cells.map(renderCellRow),
    '',
    'Acquisition samples retain the raw node payload, viewport evidence, target generation, truncation, residue, and resource metrics. Presentation samples measure only construction of the #2190 acquired carrier; they do not apply visibility, hittability, scope, depth, or semantic compaction.',
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
    `- Restored: **${report.preferenceEvidence.restored}**`,
    `- Simulator state before experiment: ${report.preferenceEvidence.simulatorStateBefore}`,
    '- Private/preboot preference keys are experimental only; they were applied to this shutdown disposable Simulator and the original plist bytes were restored.',
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
    `- Swift: ${report.toolchain.swift}`,
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
  return `| ${cell.candidate} | ${cell.state} | ${cell.screen} | ${acquisition.length} | ${summary(acquisition, 'wallClockMs')} | ${summary(acquisition, 'firstLookMs')} | ${summary(presentation, 'wallClockMs')} | ${formatNumber(median(nodeCounts))} | ${failures} |`;
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
  if (report.config.candidates.includes(candidate)) return 'not exercised';
  return 'not selected';
}

function preferenceLines(report: SpikeReport): string[] {
  return report.preferenceEvidence.diffs.flatMap((diff) => [
    `- ${diff.path}: existed=${diff.existedBefore}, beforeSha256=${diff.beforeSha256 ?? 'missing'}, afterSha256=${diff.afterSha256 ?? 'missing'}`,
    `  - Changes: ${diff.changes.length === 0 ? 'none' : diff.changes.map((change) => `${change.key}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`).join('; ')}`,
  ]);
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

function percentile(values: readonly number[], percentage: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((percentage / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '–';
}
