// Entry point for `pnpm check:affected --base <ref>`.
//
// Derives the affected local check set from the diff against <ref>, prints a
// stable machine-readable plan (with per-check reasoning), and optionally runs
// the locally-runnable checks. Fails open to the full set on anything it cannot
// classify. Existing GitHub CI stays authoritative.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertCatalogComplete,
  CHECK_CATALOG,
  getCheckSpec,
  resolveCommand,
  type CheckSpec,
} from './checks.ts';
import { ALL_CHECKS, selectChecks, type CheckPlan, type VitestProject } from './model.ts';

type Args = { base: string; head: string; json: boolean; run: boolean };

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { base: 'origin/main', head: 'HEAD', json: false, run: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base') args.base = argv[++i] ?? args.base;
    else if (arg === '--head') args.head = argv[++i] ?? args.head;
    else if (arg === '--json') args.json = true;
    else if (arg === '--run') args.run = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: pnpm check:affected [--base <ref>] [--head <ref>] [--json] [--run]\n',
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function readChangedFiles(base: string, head: string): string[] {
  const out = execFileSync('git', ['diff', '--name-only', '--merge-base', base, head], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

async function loadVitestProjects(): Promise<VitestProject[]> {
  const module = (await import(pathToFileURL(path.join(repoRoot, 'vitest.config.ts')).href)) as {
    default: { test?: { projects?: Array<{ test?: VitestProject }> } };
  };
  const projects = module.default.test?.projects ?? [];
  return projects
    .map((project) => project.test)
    .filter((project): project is VitestProject => Boolean(project?.name && project.include));
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

function printPlanHuman(plan: CheckPlan, args: Args): void {
  const write = (line: string): void => void process.stdout.write(`${line}\n`);
  write(`check:affected — diff ${args.base}...${args.head}`);
  if (plan.failOpen) {
    write('Fail-open: selecting the full check set.');
    for (const reason of plan.failOpenReasons) {
      write(`  ! ${reason.path} [${reason.rule}] — ${reason.detail}`);
    }
  }
  if (plan.checks.length === 0) {
    write('No local checks selected.');
    if (plan.docsOnlyPaths.length > 0) {
      write(`  Docs-only changes: ${plan.docsOnlyPaths.length} file(s).`);
    }
    return;
  }
  write(`Selected ${plan.checks.length} check(s):`);
  for (const id of plan.checks) {
    const spec = getCheckSpec(id);
    const local = spec.localRunnable ? '' : ' (GitHub-authoritative; not run locally)';
    write(`  - ${id}: ${spec.label}${local}`);
    if (!plan.failOpen) {
      for (const reason of plan.reasons.filter((entry) => entry.check === id)) {
        write(`      · ${reason.path} [${reason.rule}] — ${reason.detail}`);
      }
    }
  }
  if (plan.docsOnlyPaths.length > 0) {
    write(`Docs-only changes ignored: ${plan.docsOnlyPaths.length} file(s).`);
  }
}

function runChecks(plan: CheckPlan, pkg: PackageJson, args: Args): number {
  const runnable = plan.checks.map(getCheckSpec).filter((spec: CheckSpec) => spec.localRunnable);
  const skipped = plan.checks.map(getCheckSpec).filter((spec: CheckSpec) => !spec.localRunnable);
  for (const spec of skipped) {
    process.stdout.write(
      `\n[skip] ${spec.id} — GitHub-authoritative (jobs: ${spec.ciJobs.join(', ')})\n`,
    );
  }
  for (const spec of runnable) {
    const command = resolveCommand(spec, pkg.scripts, args.base);
    process.stdout.write(`\n[run] ${spec.id}: ${command.join(' ')}\n`);
    try {
      execFileSync(command[0]!, command.slice(1), { cwd: repoRoot, stdio: 'inherit' });
    } catch {
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
  const vitestProjects = await loadVitestProjects();
  const changedFiles = readChangedFiles(args.base, args.head);
  const plan = selectChecks({
    changedFiles,
    vitestProjects,
    packageEntryFiles: packageEntryFiles(pkg),
  });

  if (args.json) printPlanJson(plan, args);
  else printPlanHuman(plan, args);

  if (args.run) return runChecks(plan, pkg, args);
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
