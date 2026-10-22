import fs from 'node:fs';
import path from 'node:path';
import type { Measurement, PerfSummary, Stat } from './types.ts';

export const SUMMARY_FILE = 'summary.json';
export const REPORT_FILE = 'report.md';

function ms(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(0) : '–';
}

function pct(n: number | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? `${(n * 100).toFixed(0)}%` : '–';
}

function keys(counts: Record<string, number> | undefined): string {
  const entries = Object.entries(counts ?? {});
  return entries.length === 0 ? '–' : entries.map(([key, n]) => `${key}×${n}`).join(', ');
}

function wallCells(s: Stat | null): string {
  if (!s) return '– | – | – | – | – | –';
  return `${ms(s.mean)} ± ${ms(s.stddev)} | ${ms(s.median)} | ${ms(s.p95)} | ${ms(s.min)} | ${ms(s.max)} | ${pct(s.cv)}`;
}

function cell(text: string): string {
  return text.replaceAll('|', String.raw`\|`);
}

function timingRow(m: Measurement): string {
  return [
    m.id.slice(m.scenario.length + 1),
    `\`${cell(m.label)}\`${m.execMode === 'sdk' ? ' (SDK, in process; daemon = log span)' : ''}`,
    String(m.samples.length),
    wallCells(m.wallClock),
    ms(m.daemon?.median),
    String(m.failures),
  ].join(' | ');
}

function profileRow(m: Measurement): string {
  const p = m.profile;
  return [
    m.id.slice(m.scenario.length + 1),
    ms(p?.runnerMs),
    p?.spawnCount == null ? '–' : `${p.spawnCount} / ${ms(p.spawnMs)}`,
    ms(p?.snapshotSourceMs),
    ms(p?.settleWaitMs),
    ms(p?.stabilizationMs),
    String(p?.retries ?? '–'),
    cell(keys(p?.producers)),
    cell(p?.topPhases.map((t) => `${t.phase} ${ms(t.medianMs)}`).join(', ') || '–'),
  ].join(' | ');
}

/** Renders the human report for one run. */
export function renderReport(summary: PerfSummary): string {
  const meta = summary.metadata;
  const lines: string[] = [
    `# agent-device perf — ${summary.platform}`,
    '',
    `- **Commit**: ${meta.commit.slice(0, 12)}${meta.dirty ? ' (dirty)' : ''}${meta.ref ? ` (${meta.ref})` : ''}${meta.runId ? ` · run ${meta.runId}` : ''}`,
    `- **Device**: ${meta.device.name}${meta.device.runtime ? ` · ${meta.device.runtime}` : ''}`,
    `- **Toolchain**: ${meta.xcode ?? 'no Xcode'} · Node ${meta.node} · agent-device ${meta.agentDeviceVersion}`,
    `- **Host**: ${meta.host.os} · ${meta.host.cpu} · ${meta.host.cores} cores · ${meta.host.memoryGb} GB`,
    `- **Rounds**: ${summary.config.rounds} measured after ${summary.config.warmup} warmup · ${summary.startedAt} → ${summary.finishedAt}`,
    '',
    'Times are milliseconds. See scripts/perf/README.md for each metric. The second table of each',
    'scenario holds per-request medians from the daemon `--debug` request logs.',
    '',
  ];
  const scenarios = [...new Set(summary.measurements.map((m) => m.scenario))];
  for (const scenario of scenarios) {
    const measurements = summary.measurements.filter((m) => m.scenario === scenario);
    lines.push(
      `## ${scenario}`,
      '',
      '| step | command | n | wall mean ± sd | median | p95 | min | max | cv | daemon | fail |',
      '|---|---|---|---|---|---|---|---|---|---|---|',
      ...measurements.map((m) => `| ${timingRow(m)} |`),
      '',
      '| step | runner | spawns | snapshot source | settle wait | stabilization | retries | producer | top phases |',
      '|---|---|---|---|---|---|---|---|---|',
      ...measurements.map((m) => `| ${profileRow(m)} |`),
      '',
    );
  }
  const degraded = summary.measurements.filter(
    (m) =>
      Object.keys(m.profile?.fallbacks ?? {}).length > 0 ||
      Object.keys(m.profile?.backends ?? {}).length > 0,
  );
  if (degraded.length > 0) {
    lines.push('## Backends and fallbacks', '');
    for (const m of degraded) {
      lines.push(
        `- **${m.id}** — backends ${keys(m.profile?.backends)}; fallbacks ${keys(m.profile?.fallbacks)}`,
      );
    }
    lines.push('');
  }
  const failed = summary.measurements.filter((m) => m.failures > 0);
  if (failed.length > 0) {
    lines.push('## Failures', '');
    for (const m of failed) {
      const sample = m.samples.find((s) => !s.ok);
      lines.push(
        `- **${m.id}** — ${m.notes.join('; ')}${sample?.errorMessage ? ` — ${sample.errorMessage}` : ''}`,
      );
    }
    lines.push('');
  }
  lines.push(
    '## Coverage',
    '',
    `Measured commands (${summary.coverage.measured.length}): ${summary.coverage.measured.join(', ')}.`,
    '',
    ...summary.coverage.excluded.map((e) => `- \`${e.command}\` not measured: ${e.reason}`),
    '',
  );
  return lines.join('\n');
}

export function writeRunOutput(
  summary: PerfSummary,
  outDir: string,
): { jsonPath: string; mdPath: string } {
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, SUMMARY_FILE);
  const mdPath = path.join(outDir, REPORT_FILE);
  fs.writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(mdPath, renderReport(summary));
  return { jsonPath, mdPath };
}
