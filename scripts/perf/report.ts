import fs from 'node:fs';
import path from 'node:path';
import type { Measurement, RunResult, Stat } from './types.ts';

function ms(n: number | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(0) : '–';
}

function wallCells(s: Stat | null): string {
  if (!s) return '– | – | – | –';
  return `${ms(s.min)} | ${ms(s.median)} | ${ms(s.p95)} | ${ms(s.max)}`;
}

function stampName(platform: string, startedAt: string): string {
  return `perf-${platform}-${startedAt.replace(/[:.]/g, '-')}`;
}

function measurementRow(m: Measurement): string {
  const daemon = m.daemonDuration ? ms(m.daemonDuration.median) : '–';
  const elements = m.elementCount ? ms(m.elementCount.median) : '–';
  const n = m.wallClock?.n ?? 0;
  return `| ${m.label} | ${m.command} | ${m.execMode} | ${n} | ${wallCells(m.wallClock)} | ${daemon} | ${elements} | ${m.notes.join('; ')} |`;
}

function toMarkdown(run: RunResult): string {
  const lines: string[] = [];
  lines.push(`# agent-device command perf — ${run.platform}`);
  lines.push('');
  lines.push(`- **Device**: ${run.device.name} (${run.device.udid ?? run.device.serial ?? '?'})`);
  lines.push(`- **agent-device**: ${run.agentDeviceVersion}`);
  lines.push(`- **Rounds**: ${run.config.rounds} (warmup ${run.config.warmup} dropped)`);
  lines.push(`- **Started**: ${run.startedAt}`);
  lines.push(`- **Finished**: ${run.finishedAt}`);
  lines.push('');
  lines.push('All times in milliseconds. `wall-clock` includes process spawn + socket overhead;');
  lines.push('`daemon` is the batch step round-trip (spawn overhead ≈ wall-median − daemon-median).');
  lines.push('`elements` = node count in the snapshot payload (tree-size proxy).');
  lines.push('An untimed warmup interaction runs after each open/relaunch, so measured commands');
  lines.push('do not pay the one-time iOS-runner startup or post-relaunch first-AX-query cost.');
  lines.push('');
  lines.push('| command | cli | mode | n | wall min | wall median | wall p95 | wall max | daemon median | elements | notes |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const m of run.measurements) lines.push(measurementRow(m));
  lines.push('');

  const failed = run.measurements.filter((m) => m.failures > 0);
  if (failed.length > 0) {
    lines.push('## Failures');
    lines.push('');
    for (const m of failed) {
      const sample = m.samples.find((s) => !s.ok);
      lines.push(`- **${m.label}** — ${m.notes.join('; ')}${sample?.errorMessage ? ` — ${sample.errorMessage}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function writeReports(run: RunResult, outDir: string): { jsonPath: string; mdPath: string } {
  fs.mkdirSync(outDir, { recursive: true });
  const base = stampName(run.platform, run.startedAt);
  const jsonPath = path.join(outDir, `${base}.json`);
  const mdPath = path.join(outDir, `${base}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(run, null, 2));
  fs.writeFileSync(mdPath, toMarkdown(run));
  return { jsonPath, mdPath };
}
