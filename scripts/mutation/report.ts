// Markdown rendering for the mutation lane: GitHub job summary and terminal
// output share one renderer, so the artifact and the console never disagree.
//
// The lane reports and never gates (#1457), so the report is the whole product:
// a per-kernel score table plus the surviving mutants a test-strengthening PR
// would have to kill.

import { moduleById } from './modules.ts';
import type { ModuleScore } from './score.ts';

const DEFAULT_MAX_SURVIVING_LISTED = 20;

export type Provenance = { readonly strykerVersion: string; readonly configHash: string };

function renderRow(score: ModuleScore): string {
  const module = moduleById(score.module);
  return (
    `| \`${score.module}\` — ${module.label} | ${score.score}% | ${score.killed} | ` +
    `${score.survived} | ${score.total} | ${score.timeout} |`
  );
}

function renderDetail(score: ModuleScore, maxListed: number): string[] {
  const lines = [
    '',
    `### \`${score.module}\` — ${score.survived} surviving mutant(s) at ${score.score}%`,
    '',
  ];
  for (const mutant of score.surviving.slice(0, maxListed)) {
    lines.push(`- \`${mutant.file}:${mutant.line}\` ${mutant.mutator}`);
  }
  if (score.surviving.length > maxListed) {
    lines.push(`- …and ${score.surviving.length - maxListed} more`);
  }
  return lines;
}

export type RenderOptions = {
  readonly title?: string;
  readonly maxSurvivingListed?: number;
};

export function renderReport(
  scores: readonly ModuleScore[],
  provenance: Provenance,
  options: RenderOptions = {},
): string {
  const maxListed = options.maxSurvivingListed ?? DEFAULT_MAX_SURVIVING_LISTED;
  const lines: string[] = [
    `## ${options.title ?? 'Mutation score — decision kernels'}`,
    '',
    `Stryker \`${provenance.strykerVersion}\` · config \`${provenance.configHash}\` · ` +
      'report only — this lane never fails a build.',
    '',
    '| Kernel | Score | Killed | Survived | Total | Timeout |',
    '| --- | --- | --- | --- | --- | --- |',
    ...scores.map(renderRow),
  ];

  for (const score of scores) {
    if (score.surviving.length > 0) lines.push(...renderDetail(score, maxListed));
  }

  lines.push(
    '',
    'A low score names tests worth strengthening (#1474, #1475 were written from this table); ' +
      'it is an input for a human-authored PR, not a verdict.',
  );
  return `${lines.join('\n')}\n`;
}
