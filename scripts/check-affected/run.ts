// Entry point for `pnpm check:affected --base <ref>`.
//
// Derives the affected local check set from the diff against <ref>, prints a
// stable machine-readable plan (with per-check reasoning), and optionally runs
// the locally-runnable checks. Fails open to the full set on anything it cannot
// classify. Existing GitHub CI stays authoritative.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs as parseNodeArgs } from 'node:util';
import { runCmdStreaming, runCmdSync } from '../../src/utils/exec.ts';
import {
  assertCatalogComplete,
  CHECK_CATALOG,
  getCheckSpec,
  resolveCommand,
  type CheckSpec,
} from './checks.ts';
import { ALL_CHECKS, selectChecks, type CheckPlan } from './model.ts';

type Args = { base: string; head: string; json: boolean; run: boolean };

const repoRoot = runCmdSync('git', ['rev-parse', '--show-toplevel']).stdout.trim();

const USAGE = 'Usage: pnpm check:affected [--base <ref>] [--head <ref>] [--json] [--run]\n';

function parseArgs(argv: readonly string[]): Args {
  const { values } = parseNodeArgs({
    args: [...argv],
    options: {
      base: { type: 'string', default: 'origin/main' },
      head: { type: 'string', default: 'HEAD' },
      json: { type: 'boolean', default: false },
      run: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  return {
    base: values.base ?? 'origin/main',
    head: values.head ?? 'HEAD',
    json: Boolean(values.json),
    run: Boolean(values.run),
  };
}

function gitLines(args: string[], cwd: string): string[] {
  return runCmdSync('git', args, { cwd }).stdout.split('\n').filter(Boolean);
}

// Collect every changed file a local plan must account for. The committed diff
// (base..head via merge-base) is the baseline; `--no-renames` keeps BOTH sides
// of a rename so a moved file cannot look docs-only by its destination alone.
// In local mode (head === HEAD) we also fold in working-tree changes and
// untracked files, which the committed diff never sees — ignoring uncommitted
// edits would be an unsafe narrowing of the local feedback loop. The staged
// (`--cached`) and unstaged diffs are collected separately and unioned: a
// single `git diff HEAD` nets index against working tree, so a staged add and
// an unstaged delete of the same file would cancel and hide it.
export function readChangedFiles(base: string, head: string, cwd: string = repoRoot): string[] {
  const files = new Set<string>(
    gitLines(['diff', '--name-only', '--no-renames', '--merge-base', base, head], cwd),
  );
  if (head === 'HEAD') {
    for (const args of [
      ['diff', '--name-only', '--no-renames', '--cached'], // staged vs HEAD
      ['diff', '--name-only', '--no-renames'], // unstaged (working tree vs index)
      ['ls-files', '--others', '--exclude-standard'], // untracked
    ]) {
      for (const file of gitLines(args, cwd)) files.add(file);
    }
  }
  return [...files].sort();
}

type PackageJson = {
  scripts: Record<string, string>;
  exports?: Record<string, { import?: string }>;
};

function loadPackageJson(): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as PackageJson;
}

// Public package surface = the source files behind package.json `exports`.
function packageEntryFiles(pkg: PackageJson): string[] {
  return Object.values(pkg.exports ?? {})
    .map((entry) => entry.import)
    .filter((target): target is string => typeof target === 'string')
    .map((target) => target.replace(/^\.\/dist\//, '').replace(/\.js$/, '.ts'));
}

function printPlanJson(plan: CheckPlan, args: Args): void {
  const checks = plan.checks.map((id) => {
    const spec = getCheckSpec(id);
    return {
      id,
      label: spec.label,
      ciJobs: spec.ciJobs,
      localRunnable: spec.localRunnable,
      reasons: plan.reasons.filter((reason) => reason.check === id),
    };
  });
  const notSelected = ALL_CHECKS.filter((id) => !plan.checks.includes(id));
  process.stdout.write(
    `${JSON.stringify(
      {
        base: args.base,
        head: args.head,
        failOpen: plan.failOpen,
        failOpenReasons: plan.failOpenReasons,
        docsOnlyPaths: plan.docsOnlyPaths,
        checks,
        notSelected,
      },
      null,
      2,
    )}\n`,
  );
}

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function printCheckLine(plan: CheckPlan, id: (typeof plan.checks)[number]): void {
  const spec = getCheckSpec(id);
  const local = spec.localRunnable ? '' : ' (GitHub-authoritative; not run locally)';
  writeLine(`  - ${id}: ${spec.label}${local}`);
  if (plan.failOpen) return;
  for (const reason of plan.reasons.filter((entry) => entry.check === id)) {
    writeLine(`      · ${reason.path} [${reason.rule}] — ${reason.detail}`);
  }
}

function printFailOpen(plan: CheckPlan): void {
  writeLine('Fail-open: selecting the full check set.');
  for (const reason of plan.failOpenReasons) {
    writeLine(`  ! ${reason.path} [${reason.rule}] — ${reason.detail}`);
  }
}

function printSelected(plan: CheckPlan): void {
  if (plan.checks.length === 0) {
    writeLine('No local checks selected.');
    return;
  }
  writeLine(`Selected ${plan.checks.length} check(s):`);
  for (const id of plan.checks) printCheckLine(plan, id);
}

function printPlanHuman(plan: CheckPlan, args: Args): void {
  writeLine(`check:affected — diff ${args.base}...${args.head}`);
  if (plan.failOpen) printFailOpen(plan);
  printSelected(plan);
  if (plan.docsOnlyPaths.length > 0) {
    writeLine(`Docs-only changes ignored: ${plan.docsOnlyPaths.length} file(s).`);
  }
}

// How a resolved command is executed. Injectable so the entrypoint's `--run`
// propagation (order, skip of GitHub-authoritative checks, stop-on-failure) is
// testable without spawning real processes.
export type CommandExecutor = (command: string[], cwd: string) => Promise<number>;

const streamingExecutor: CommandExecutor = async (command, cwd) => {
  const result = await runCmdStreaming(command[0]!, command.slice(1), {
    cwd,
    allowFailure: true,
    onStdoutChunk: (chunk) => void process.stdout.write(chunk),
    onStderrChunk: (chunk) => void process.stderr.write(chunk),
  });
  return result.exitCode;
};

export async function runChecks(
  plan: CheckPlan,
  pkg: PackageJson,
  args: Args,
  options: { cwd?: string; execute?: CommandExecutor; changedFiles?: readonly string[] } = {},
): Promise<number> {
  const cwd = options.cwd ?? repoRoot;
  const execute = options.execute ?? streamingExecutor;
  const runnable = plan.checks.map(getCheckSpec).filter((spec: CheckSpec) => spec.localRunnable);
  const skipped = plan.checks.map(getCheckSpec).filter((spec: CheckSpec) => !spec.localRunnable);
  for (const spec of skipped) {
    process.stdout.write(
      `\n[skip] ${spec.id} — GitHub-authoritative (jobs: ${spec.ciJobs.join(', ')})\n`,
    );
  }
  for (const spec of runnable) {
    const command = resolveCommand(spec, pkg.scripts, args.base, options.changedFiles);
    process.stdout.write(`\n[run] ${spec.id}: ${command.join(' ')}\n`);
    const exitCode = await execute(command, cwd);
    if (exitCode !== 0) {
      process.stderr.write(`\ncheck:affected: ${spec.id} failed.\n`);
      return 1;
    }
  }
  process.stdout.write('\ncheck:affected: all runnable checks passed.\n');
  return 0;
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  assertCatalogComplete();
  const args = parseArgs(argv);
  const pkg = loadPackageJson();
  // Validate every catalog command resolves before selecting, so a broken
  // catalog fails loudly rather than silently dropping a gate.
  for (const spec of CHECK_CATALOG) resolveCommand(spec, pkg.scripts, args.base);
  const changedFiles = readChangedFiles(args.base, args.head);
  const plan = selectChecks({
    changedFiles,
    packageEntryFiles: packageEntryFiles(pkg),
  });

  if (args.json) printPlanJson(plan, args);
  else printPlanHuman(plan, args);

  if (args.run) return await runChecks(plan, pkg, args, { changedFiles });
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`check:affected: ${error instanceof Error ? error.message : error}\n`);
      process.exit(1);
    },
  );
}
