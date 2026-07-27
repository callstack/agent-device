// Markdown rendering for the mutation lane: GitHub job summary and terminal
// output share one renderer, so the artifact and the console never disagree.

import { moduleById } from './modules.ts';
import type { Baseline, ModuleVerdict, Provenance, RatchetResult } from './ratchet.ts';

const DEFAULT_MAX_SURVIVING_LISTED = 20;

function formatDelta(delta: number | undefined): string {
  if (delta === undefined) return '—';
  return delta > 0 ? `+${delta}` : String(delta);
}

function renderRow(verdict: ModuleVerdict): string {
  const module = moduleById(verdict.module);
  const baseline = verdict.baselineScore === undefined ? '—' : `${verdict.baselineScore}%`;
  return (
    `| \`${verdict.module}\` — ${module.label} | ${verdict.score}% | ${baseline} | ` +
    `${formatDelta(verdict.delta)} | ${verdict.killed}/${verdict.total} | ` +
    `${verdict.surviving.length} | ${verdict.status} |`
  );
}

function renderDetail(verdict: ModuleVerdict, maxListed: number): string[] {
  const lines = ['', `### \`${verdict.module}\` — ${verdict.status}`, '', verdict.detail];
  if (verdict.surviving.length > 0) {
    lines.push('', 'Surviving mutants:', '');
    for (const mutant of verdict.surviving.slice(0, maxListed)) {
      lines.push(`- \`${mutant.file}:${mutant.line}\` ${mutant.mutator}`);
    }
    if (verdict.surviving.length > maxListed) {
      lines.push(`- …and ${verdict.surviving.length - maxListed} more`);
    }
  }
  return lines;
}

export type RenderOptions = {
  readonly title?: string;
  readonly maxSurvivingListed?: number;
};

export function renderReport(
  result: RatchetResult,
  baseline: Baseline,
  provenance: Provenance,
  options: RenderOptions = {},
): string {
  const maxListed = options.maxSurvivingListed ?? DEFAULT_MAX_SURVIVING_LISTED;
  const lines: string[] = [
    `## ${options.title ?? 'Mutation score — decision kernels'}`,
    '',
    `Stryker \`${provenance.strykerVersion}\` · config \`${provenance.configHash}\` · ` +
      `gating **${baseline.gating ? 'on' : 'off'}** ` +
      `(${baseline.stableRuns}/${baseline.requiredStableRuns} stable weekly runs)`,
    '',
    '| Module | Score | Baseline | Δ | Killed/Total | Surviving | Status |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...result.verdicts.map(renderRow),
  ];

  for (const verdict of [...result.regressions, ...result.drifted]) {
    lines.push(...renderDetail(verdict, maxListed));
  }

  if (result.failed) {
    lines.push(
      '',
      'Mutation ratchet failed: scores may only rise. Kill the surviving mutants listed above, ' +
        'then re-run `pnpm mutation:run` (full sweep) or `pnpm mutation:check --report <file>` ' +
        'against an existing Stryker report.',
    );
  } else if (result.regressions.length > 0) {
    lines.push(
      '',
      'Scores regressed while the lane is still non-gating — no failure recorded, but the ' +
        'surviving mutants above are the tests to strengthen before gating turns on.',
    );
  }
  return `${lines.join('\n')}\n`;
}
