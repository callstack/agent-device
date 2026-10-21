import fs from 'node:fs';
import path from 'node:path';
import { compareRuns, renderComparison, type Comparison } from './compare.ts';
import { REPO_ROOT } from './config.ts';
import {
  baselineCandidates,
  coversTarget,
  fetchSummary,
  listRuns,
  readLocalSummary,
  resolveRunRef,
  selectRange,
  SUMMARY_ARTIFACT,
  type NightlySource,
  type WorkflowRun,
} from './nightly-artifacts.ts';
import type { PerfSummary } from './types.ts';

const USAGE = `Usage: pnpm perf:compare [--to <ref>] [--from <ref>|<ref>..<ref>] [--nights <n>] [options]

Compares one perf run with earlier runs and prints a Markdown verdict per step.

A <ref> is latest, a workflow run id, a YYYY-MM-DD date (the newest run that UTC day), or a local
path to a summary.json or a \`pnpm perf\` output directory.

  --to <ref>            Run to judge (default: latest).
  --from <ref>          Baseline run, or an inclusive range <ref>..<ref>. Without it the baseline is
                        the --nights runs before --to.
  --nights <n>          Rolling baseline size (default: 7).
  --branch <name>       Branch whose nightly runs are listed (default: main).
  --repo <owner/name>   Repository (default: $GITHUB_REPOSITORY or callstack/agent-device).
  --workflow <file>     Workflow file (default: perf-nightly.yml).
  --cache-dir <dir>     Download cache (default: .tmp/perf-nightly).
  --exclude-run <id>    Never use this run as baseline (repeatable).
  --out <dir>           Also write comparison.json and comparison.md there.
  --github              Append the Markdown to $GITHUB_STEP_SUMMARY and annotate flagged steps.`;

type Options = {
  to: string;
  from?: string;
  nights: number;
  out?: string;
  github: boolean;
  exclude: Set<string>;
  source: NightlySource;
};

function parse(argv: string[]): Options {
  const options: Options = {
    to: 'latest',
    nights: 7,
    github: false,
    exclude: new Set(),
    source: {
      repo: process.env.GITHUB_REPOSITORY ?? 'callstack/agent-device',
      workflow: 'perf-nightly.yml',
      branch: 'main',
      artifact: SUMMARY_ARTIFACT,
      cacheDir: path.join(REPO_ROOT, '.tmp', 'perf-nightly'),
    },
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`Missing value for ${flag}`);
      return next;
    };
    switch (flag) {
      case '--to':
        options.to = value();
        break;
      case '--from':
        options.from = value();
        break;
      case '--nights': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1) throw new Error('--nights must be a positive integer');
        options.nights = n;
        break;
      }
      case '--branch':
        options.source.branch = value();
        break;
      case '--repo':
        options.source.repo = value();
        break;
      case '--workflow':
        options.source.workflow = value();
        break;
      case '--cache-dir':
        options.source.cacheDir = path.resolve(value());
        break;
      case '--exclude-run':
        options.exclude.add(value());
        break;
      case '--out':
        options.out = path.resolve(value());
        break;
      case '--github':
        options.github = true;
        break;
      case '--help':
      case '-h':
        process.stdout.write(`${USAGE}\n`);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown flag: ${flag}\n\n${USAGE}`);
    }
  }
  return options;
}

type Loaded = { summary: PerfSummary; label: string; run?: WorkflowRun };

function main(): void {
  const options = parse(process.argv.slice(2));
  let runs: WorkflowRun[] | undefined;
  const allRuns = (): WorkflowRun[] => (runs ??= listRuns(options.source));
  const runLabel = (run: WorkflowRun) => `run ${run.id} (${run.createdAt.slice(0, 10)})`;
  const load = (ref: string): Loaded => {
    if (fs.existsSync(ref))
      return { summary: readLocalSummary(ref), label: path.basename(path.resolve(ref)) };
    const run = resolveRunRef(ref, allRuns());
    if (!run)
      throw new Error(
        `No completed ${options.source.workflow} run on ${options.source.branch} matches ${ref}.`,
      );
    const summary = fetchSummary(options.source, run);
    if (!summary) throw new Error(`Run ${run.id} has no ${options.source.artifact} artifact.`);
    return { summary, label: runLabel(run), run };
  };
  const loadRuns = (
    candidates: WorkflowRun[],
    limit: number,
    accept: (summary: PerfSummary) => boolean = () => true,
  ): Loaded[] => {
    const loaded: Loaded[] = [];
    for (const run of candidates) {
      if (loaded.length >= limit) break;
      const summary = fetchSummary(options.source, run);
      if (summary && accept(summary)) loaded.push({ summary, label: runLabel(run), run });
    }
    return loaded;
  };

  const target = load(options.to);
  const exclude = new Set([...options.exclude, ...(target.run ? [target.run.id] : [])]);
  let baseline: Loaded[];
  if (options.from?.includes('..')) {
    const [fromRef, toRef] = options.from.split('..');
    const range = selectRange(allRuns(), fromRef!, toRef!).filter((run) => !exclude.has(run.id));
    baseline = loadRuns(range, range.length);
  } else if (options.from) {
    baseline = [load(options.from)];
  } else {
    const before = target.run?.createdAt ?? target.summary.startedAt;
    baseline = loadRuns(baselineCandidates(allRuns(), before, exclude), options.nights, (summary) =>
      coversTarget(summary, target.summary),
    );
  }

  const comparison = compareRuns(target, baseline);
  const markdown = renderComparison(comparison);
  process.stdout.write(`${markdown}\n`);
  if (options.out) writeComparison(comparison, markdown, options.out);
  if (options.github) publishToGitHub(comparison, markdown);
}

function writeComparison(comparison: Comparison, markdown: string, dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'comparison.md'), markdown);
}

function publishToGitHub(comparison: Comparison, markdown: string): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) fs.appendFileSync(summaryPath, `${markdown}\n`);
  for (const row of comparison.rows) {
    if (row.verdict === 'regression' || row.verdict === 'new-failures') {
      const change =
        row.verdict === 'regression'
          ? `median ${row.target?.median.toFixed(0)} ms vs ${row.baseline?.median.toFixed(0)} ms baseline`
          : `${row.target?.failures}/${row.target?.samples} samples failed`;
      process.stdout.write(`::warning title=perf ${row.verdict}::${row.id}: ${change}\n`);
    }
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`[perf:compare] ${(error as Error).message}\n`);
  process.exit(1);
}
