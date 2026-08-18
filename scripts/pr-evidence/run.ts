// `pnpm pr:evidence [--base <ref>] [--coverage] [--size] [--json]`
//
// One paste-ready evidence block for a PR body, stamped with the exact base and head, composed
// from the tools the repo already has: the affected selector (`check:affected --json`), the
// layering guard, the depgraph report, and — behind flags, because they need a build or a
// coverage run — the changed-line coverage gate and `pnpm size --base`. It measures nothing
// itself and claims nothing about CI: the last line is the link to the head's checks.
//
// Everything labelled "at <head>" is measured from a throwaway `git worktree` of that exact
// commit, and the base likewise, so an untracked or uncommitted file in the working tree can
// change nothing the block reports as HEAD's; the working tree only contributes the "dirty"
// flag. The worktrees need no install: the scripts analyze whichever repository their cwd is
// in, while their imports resolve from this checkout.
//
// The default tier finishes in ~20s (the layering guard is most of it). `--coverage` reads the
// existing coverage/lcov.info (run `pnpm test:coverage` first); `--size` runs the base worktree
// build the first time (~1-2 min) and ~3s afterwards.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCmd, runCmdSync } from '../../src/utils/exec.ts';
import { parseScriptArgs } from '../lib/cli-args.ts';
import { runEntrypoint } from '../lib/cli-entrypoint.ts';
import {
  depgraphFacts,
  parseLayeringReport,
  renderEvidence,
  type AffectedPlan,
  type DepgraphFacts,
  type EvidenceInputs,
  type GitFacts,
} from './model.ts';

const USAGE =
  'Usage: pnpm pr:evidence [--base <ref>] [--coverage] [--size] [--json]\n' +
  '  --base <ref>   Base ref (default origin/main); the block uses its merge-base with HEAD\n' +
  '  --coverage     Include changed-line coverage from coverage/lcov.info (run pnpm test:coverage first)\n' +
  '  --size         Include the JS size delta (pnpm size --base <merge-base>; needs pnpm build)\n' +
  '  --json         Emit the collected inputs as JSON instead of the markdown block\n';

const REPOSITORY = 'callstack/agent-device';
const repoRoot = runCmdSync('git', ['rev-parse', '--show-toplevel']).stdout.trim();
const scripts = path.join(repoRoot, 'scripts');

function git(args: readonly string[], cwd = repoRoot): string {
  return runCmdSync('git', [...args], { cwd }).stdout.trim();
}

function collectGitFacts(baseRef: string): GitFacts {
  const head = git(['rev-parse', 'HEAD']);
  const base = git(['merge-base', baseRef, 'HEAD']);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  // Untracked files count: they are exactly what a pristine-worktree measurement leaves out.
  const dirty = git(['status', '--porcelain']).length > 0;
  const changedFiles = git(['diff', '--name-only', '--no-renames', `${base}..HEAD`])
    .split('\n')
    .filter(Boolean);
  return {
    branch,
    head,
    headShort: head.slice(0, 9),
    base,
    baseRef,
    baseShort: base.slice(0, 9),
    dirty,
    changedFiles,
  };
}

// The head SHA, not the literal `HEAD`: the selector folds working-tree changes into a plan for
// `HEAD`, and this block describes the commit.
async function collectAffected(base: string, head: string): Promise<AffectedPlan> {
  const result = await runCmd(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(scripts, 'check-affected', 'run.ts'),
      '--base',
      base,
      '--head',
      head,
      '--json',
    ],
    { cwd: repoRoot, timeoutMs: 120_000 },
  );
  const parsed = JSON.parse(result.stdout) as AffectedPlan;
  return {
    failOpen: parsed.failOpen,
    failOpenReasons: parsed.failOpenReasons,
    checks: parsed.checks.map(({ id, localRunnable, ciJobs }) => ({ id, localRunnable, ciJobs })),
  };
}

async function collectLayering(cwd: string) {
  const result = await runCmd(
    process.execPath,
    ['--experimental-strip-types', path.join(scripts, 'layering', 'check.ts')],
    { cwd, timeoutMs: 300_000, allowFailure: true },
  );
  return parseLayeringReport(`${result.stdout}\n${result.stderr}`, result.exitCode);
}

async function collectDepgraph(cwd: string, out: string): Promise<DepgraphFacts> {
  await runCmd(
    process.execPath,
    ['--experimental-strip-types', path.join(scripts, 'depgraph', 'build.ts'), '--out', out],
    { cwd, timeoutMs: 300_000 },
  );
  return depgraphFacts(JSON.parse(fs.readFileSync(out, 'utf8')));
}

/** A pristine checkout of one commit; removed by the caller's scratch cleanup. */
function addWorktree(scratch: string, name: string, commit: string): string {
  const worktree = path.join(scratch, name);
  git(['worktree', 'add', '--detach', worktree, commit]);
  return worktree;
}

function removeWorktree(worktree: string): void {
  git(['worktree', 'remove', '--force', worktree]);
}

async function collectCoverage(base: string): Promise<EvidenceInputs['coverage']> {
  if (!fs.existsSync(path.join(repoRoot, 'coverage', 'lcov.info'))) {
    return { kind: 'skipped', reason: 'no coverage/lcov.info — run pnpm test:coverage first' };
  }
  const result = await runCmd(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(scripts, 'coverage-changed', 'run.ts'),
      '--base',
      base,
    ],
    { cwd: repoRoot, timeoutMs: 300_000, allowFailure: true },
  );
  return { kind: 'table', markdown: result.stdout };
}

async function collectSize(base: string): Promise<EvidenceInputs['size']> {
  if (!fs.existsSync(path.join(repoRoot, 'dist', 'src'))) {
    return { kind: 'skipped', reason: 'no dist/src — run pnpm build first' };
  }
  const result = await runCmd(
    process.execPath,
    [path.join(scripts, 'size-report.mjs'), '--base', base],
    { cwd: repoRoot, timeoutMs: 600_000 },
  );
  return { kind: 'table', markdown: result.stdout };
}

/** The two report tiers that need a build or a coverage run stay opt-in; the block says so. */
async function optional<T>(
  enabled: boolean | undefined,
  flag: string,
  collect: () => Promise<T>,
): Promise<T | Readonly<{ kind: 'skipped'; reason: string }>> {
  return enabled ? await collect() : { kind: 'skipped', reason: `pass ${flag}` };
}

async function main(argv: readonly string[]): Promise<number> {
  const values = parseScriptArgs(argv, USAGE, {
    base: { type: 'string', default: 'origin/main' },
    coverage: { type: 'boolean', default: false },
    size: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  });
  const baseRef = values.base ?? 'origin/main';
  const gitFacts = collectGitFacts(baseRef);
  // os.tmpdir() always exists; a repo-local scratch would have to be created first and is one
  // more thing a fresh checkout can lack.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-pr-evidence-'));
  const worktrees: string[] = [];
  try {
    const headTree = addWorktree(scratch, 'head', gitFacts.head);
    const baseTree = addWorktree(scratch, 'base', gitFacts.base);
    worktrees.push(headTree, baseTree);
    const [affected, layering, head, base] = await Promise.all([
      collectAffected(gitFacts.base, gitFacts.head),
      collectLayering(headTree),
      collectDepgraph(headTree, path.join(scratch, 'depgraph-head.json')),
      collectDepgraph(baseTree, path.join(scratch, 'depgraph-base.json')),
    ]);
    const inputs: EvidenceInputs = {
      generatedAt: new Date().toISOString(),
      repository: REPOSITORY,
      git: gitFacts,
      affected,
      layering,
      depgraph: { head, base },
      coverage: await optional(values.coverage, '--coverage', () => collectCoverage(gitFacts.base)),
      size: await optional(values.size, '--size', () => collectSize(gitFacts.base)),
    };
    process.stdout.write(
      values.json ? `${JSON.stringify(inputs, null, 2)}\n` : renderEvidence(inputs),
    );
    return 0;
  } finally {
    for (const worktree of worktrees) removeWorktree(worktree);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runEntrypoint('pr-evidence', () => main(process.argv.slice(2)));
}
