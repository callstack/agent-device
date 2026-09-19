// Placement-legibility report — can an outside reader file a module into its family from its
// imports, its test, and the commit that placed it?
//
//   node --experimental-strip-types scripts/legibility/run.ts [--all] [--sample <n>] [--seed <n>]
//     [--out <path>] [--ablation] [--with-test-dir] [--raw-subject] [--max-requests <n>] [--batch-size <n>]
//
// Asks the `typesafe-ai/jev` evaluation model one choice question per file through AI Gateway
// and scores it against where the file actually landed, next to the majority, neighbour-vote,
// and k-NN baselines. The scored condition is `reader`: real repository paths, the way a reader
// who opened the tree sees them. `--ablation` adds the name-withheld pass, which is the same
// evidence with every family name scrubbed out of the paths too; the gap between the two is how
// much of the score a directory name carries on its own. Report-only. Needs AI_GATEWAY_API_KEY
// for the report, never for its tests.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { baselinePredictions, majorityFamily, type BaselinePrediction } from './baselines.ts';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_REQUESTS,
  evaluateInBatches,
  type BatchItem,
} from './batches.ts';
import type { CorpusFile } from './corpus.ts';
import {
  auditOwnFamilyLeaks,
  conditionLabel,
  EVIDENCE_LEGEND,
  evidenceLine,
  MAX_LEAK_RATE,
  QUESTION_TEXT,
  READER_CONDITION,
  taskText,
  WITHHELD_CONDITION,
  type EvidenceCondition,
} from './evidence.ts';
import {
  createJevEvaluator,
  describeMissingKey,
  readGatewayKey,
  type Evaluator,
} from './jev-client.ts';
import { loadLegibilityInputs, type LegibilityInputs } from './load.ts';
import { createScrubber } from './redaction.ts';
import {
  buildLegibilityReport,
  formatLegibilitySummary,
  type ConditionRun,
  type LeakReference,
} from './report.ts';
import { DEFAULT_SAMPLE_SIZE, DEFAULT_SEED, stratifiedSample } from './sampling.ts';
import { scoreRun } from './score.ts';

const USAGE =
  'Usage: pnpm legibility [--all | --sample <n>] [--seed <n>] [--out <path>]\n' +
  '                       [--ablation] [--with-test-dir] [--raw-subject]\n' +
  '                       [--max-requests <n>] [--batch-size <n>]\n' +
  '\n' +
  '  --all            evaluate every production file (default: a seeded 300-file sample)\n' +
  '  --sample <n>     sample size (default 300)\n' +
  '  --seed <n>       sample seed (default 2677)\n' +
  '  --out <path>     report path (default .tmp/legibility/report.json)\n' +
  '  --ablation       also evaluate the name-withheld condition (costs a second full pass)\n' +
  '  --with-test-dir  also run the mirror-leak reference condition (never the score)\n' +
  '  --raw-subject    also run the naming-leak reference condition (never the score)\n' +
  '  --max-requests   stop after this many evaluation calls (default 200)\n' +
  '  --batch-size     questions per evaluation call (default 40)\n';

export type RunDeps = {
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  load: (repoRoot: string) => LegibilityInputs;
  createEvaluator: (apiKey: string) => Evaluator;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  now: () => Date;
  headCommit: () => string;
};

function positiveInteger(flag: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} expects a positive integer, got ${JSON.stringify(value)}\n${USAGE}`);
  }
  return parsed;
}

function questionFor(line: string, families: readonly string[]): BatchItem['question'] {
  return {
    type: 'choice',
    instructions: `${QUESTION_TEXT}\nEvidence: ${line}`,
    criteria: Object.fromEntries(families.map((family) => [family, null])),
  };
}

export async function runLegibility(argv: readonly string[], deps: RunDeps): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      all: { type: 'boolean' },
      sample: { type: 'string' },
      seed: { type: 'string' },
      out: { type: 'string' },
      ablation: { type: 'boolean' },
      'with-test-dir': { type: 'boolean' },
      'raw-subject': { type: 'boolean' },
      'max-requests': { type: 'string' },
      'batch-size': { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: true,
  });
  if (values.help) {
    deps.stdout(USAGE);
    return 0;
  }
  const key = readGatewayKey(deps.env);
  if (!key.ok) {
    deps.stderr(`${describeMissingKey(key.error)}\n`);
    return 1;
  }
  const sampleSize = positiveInteger('--sample', values.sample, DEFAULT_SAMPLE_SIZE);
  const seed = positiveInteger('--seed', values.seed, DEFAULT_SEED);
  const maxRequests = positiveInteger(
    '--max-requests',
    values['max-requests'],
    DEFAULT_MAX_REQUESTS,
  );
  const batchSize = positiveInteger('--batch-size', values['batch-size'], DEFAULT_BATCH_SIZE);
  const jsonPath = values.out
    ? path.resolve(values.out)
    : path.join(deps.repoRoot, '.tmp/legibility/report.json');

  const inputs = deps.load(deps.repoRoot);
  const { corpus } = inputs;
  const scrubber = createScrubber([...inputs.namesByFamily.values()].flat());
  const namesOf = (family: string) => inputs.namesByFamily.get(family) ?? [family];
  const familyOf = (id: string) => corpus.byId.get(id)!.family;
  const sample = values.all ? corpus.files : stratifiedSample(corpus, sampleSize, seed);

  const linesFor = (condition: EvidenceCondition) =>
    new Map(sample.map((file) => [file.id, evidenceLine(file, condition, scrubber)]));
  const scoredLines = linesFor(READER_CONDITION);
  // Two readings of the same audit. Under `reader` an own-family name in the evidence is the
  // name echo being measured, not a defect; under `withheld` it is a scrubber defect, so that
  // rate is capped whether or not the ablation pass was asked for.
  const nameEcho = auditOwnFamilyLeaks(scoredLines, familyOf, namesOf);
  const scrubAudit = auditOwnFamilyLeaks(linesFor(WITHHELD_CONDITION), familyOf, namesOf);
  deps.stdout(
    `legibility: name echo in reader evidence: ${nameEcho.leaking.length}/${nameEcho.files} files ` +
      `(${(nameEcho.rate * 100).toFixed(2)}%) — placements a directory name alone can give\n` +
      `legibility: scrubber defect under the name-withheld condition: ` +
      `${scrubAudit.leaking.length}/${scrubAudit.files} files (${(scrubAudit.rate * 100).toFixed(2)}%)\n`,
  );
  if (scrubAudit.rate > MAX_LEAK_RATE) {
    deps.stderr(
      `legibility: refusing to run — ${(scrubAudit.rate * 100).toFixed(2)}% of files still name ` +
        `their own family with names withheld (limit ${(MAX_LEAK_RATE * 100).toFixed(0)}%). ` +
        `No requests were made.\n`,
    );
    return 1;
  }

  const majority = majorityFamily(corpus);
  const baselines = new Map<string, BaselinePrediction>(
    sample.map((file) => [file.id, baselinePredictions(file, corpus, majority)]),
  );

  const evaluator = deps.createEvaluator(key.apiKey);
  const evaluate = (lines: ReadonlyMap<string, string>, condition: EvidenceCondition) =>
    evaluateInBatches(
      sample.map((file) => ({
        id: file.id,
        question: questionFor(lines.get(file.id)!, corpus.families),
      })),
      evaluator,
      {
        state: {
          task: taskText(condition),
          families: corpus.families,
          evidenceLegend: EVIDENCE_LEGEND,
        },
        batchSize,
        maxRequests,
        onProgress: (run, pending) =>
          deps.stdout(
            `  ${run.answers.size} answered, ${run.unanswered.size} unanswered, ` +
              `${run.requests} requests, ${run.splits} splits, ${pending} files pending\n`,
          ),
      },
    );

  deps.stdout(
    `legibility: evaluating ${sample.length} files (${conditionLabel(READER_CONDITION)})\n`,
  );
  const run = await evaluate(scoredLines, READER_CONDITION);
  if (
    run.unanswered.size > 0 &&
    [...run.unanswered.values()].some((r) => r.kind === 'request-cap')
  ) {
    deps.stdout(
      `legibility: request cap ${maxRequests} reached; remaining files recorded as unanswered\n`,
    );
  }
  const score = scoreRun({ sample, corpus, run, baselines, coupling: inputs.coupling });

  let ablation: ConditionRun | null = null;
  if (values.ablation) {
    deps.stdout(
      `legibility: evaluating ${sample.length} files (${conditionLabel(WITHHELD_CONDITION)})\n`,
    );
    const withheld = await evaluate(linesFor(WITHHELD_CONDITION), WITHHELD_CONDITION);
    const withheldScore = scoreRun({
      sample,
      corpus,
      run: withheld,
      baselines,
      coupling: inputs.coupling,
    });
    run.usage.inputTokens += withheld.usage.inputTokens;
    run.usage.outputTokens += withheld.usage.outputTokens;
    ablation = {
      condition: conditionLabel(WITHHELD_CONDITION),
      accuracy: withheldScore.headline.model,
      answered: withheldScore.headline.answered,
      requests: withheld.requests,
      delta:
        withheldScore.headline.model === null || score.headline.model === null
          ? null
          : withheldScore.headline.model - score.headline.model,
    };
  }

  const leakReferences: LeakReference[] = [];
  for (const condition of [
    ...(values['with-test-dir'] ? [{ ...READER_CONDITION, withTestDir: true }] : []),
    ...(values['raw-subject'] ? [{ ...READER_CONDITION, rawSubject: true }] : []),
  ]) {
    const label = conditionLabel(condition);
    deps.stdout(`legibility: evaluating ${sample.length} files (${label})\n`);
    const reference = await evaluate(linesFor(condition), condition);
    const answered = sample.filter((file: CorpusFile) => reference.answers.has(file.id));
    const correct = answered.filter(
      (file) => reference.answers.get(file.id)!.choice === file.family,
    );
    run.usage.inputTokens += reference.usage.inputTokens;
    run.usage.outputTokens += reference.usage.outputTokens;
    leakReferences.push({
      condition: label,
      accuracy: answered.length > 0 ? correct.length / answered.length : null,
      answered: answered.length,
      requests: reference.requests,
    });
  }

  const report = buildLegibilityReport({
    generated: {
      commit: deps.headCommit(),
      date: deps.now().toISOString(),
      files: corpus.files.length,
      families: corpus.families.length,
      condition: conditionLabel(READER_CONDITION),
      sample: { size: sample.length, seed, all: Boolean(values.all), ids: sample.map((f) => f.id) },
    },
    leak: scrubAudit,
    nameEcho,
    leakLimit: MAX_LEAK_RATE,
    run,
    batchSize,
    maxRequests,
    score,
    ablation,
    leakReferences,
  });
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  deps.stdout(formatLegibilitySummary(report));
  deps.stdout(`  wrote ${path.relative(deps.repoRoot, jsonPath)}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  process.exitCode = await runLegibility(process.argv.slice(2), {
    env: process.env,
    repoRoot,
    load: loadLegibilityInputs,
    createEvaluator: (apiKey) => createJevEvaluator({ apiKey }),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    now: () => new Date(),
    headCommit: () => {
      try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
          cwd: repoRoot,
          encoding: 'utf8',
        }).trim();
      } catch {
        return 'unknown';
      }
    },
  }).catch((error: unknown) => {
    process.stderr.write(`legibility: ${error instanceof Error ? error.message : error}\n`);
    return 1;
  });
}
