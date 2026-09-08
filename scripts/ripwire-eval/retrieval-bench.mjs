#!/usr/bin/env node
// Deterministic half of the ripwire evaluation: no model in the loop.
//
// For every task in tasks.json it runs one ripwire verb against the worktree pinned at the
// task's parent commit and asks a single question — does this one call surface the files the
// real change touched, and what does the answer cost? Ranks come from the order paths first
// appear in ripwire's output, which is its own ranking order.
//
// Usage: node scripts/ripwire-eval/retrieval-bench.mjs --ripwire=<bin> --worktrees=<dir> [--out=<file>]

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const hit = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const ripwire = arg('ripwire');
const worktrees = arg('worktrees');
const outPath = arg('out', join(here, 'retrieval-results.json'));
if (!ripwire || !worktrees) {
  console.error('usage: retrieval-bench.mjs --ripwire=<bin> --worktrees=<dir> [--out=<file>]');
  process.exit(2);
}

const VERBS = [
  { id: 'for', args: (task) => ['.', `--for=${task.prompt}`] },
  { id: 'pack-task', args: (task) => ['.', `--pack-task=${task.prompt}`] },
  {
    id: 'pack-task-4k',
    args: (task) => ['.', `--pack-task=${task.prompt}`, '--token-budget=4000'],
  },
  // Same verb, but fed only the identifiers the task text itself puts in backticks — a mechanical
  // distillation, not a hand-tuned query. Isolates how much of --for's result is phrasing.
  {
    id: 'for-idents',
    args: (task) => ['.', `--for=${backtickedTerms(task.prompt)}`],
    skipWhen: (task) => backtickedTerms(task.prompt) === '',
  },
];

function backtickedTerms(prompt) {
  return [...prompt.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1])
    .join(' ')
    .trim();
}

// Rank of a path in an output blob: 1-based index of its first appearance among all distinct
// repo-relative paths the output mentions, in output order.
function rankPaths(output) {
  const seen = new Map();
  const re =
    /(?:^|["'\s=(])((?:src|packages|scripts|test|android|apple|contracts)\/[\w./@+-]+\.[\w]+)/g;
  let match;
  let next = 1;
  while ((match = re.exec(output)) !== null) {
    if (!seen.has(match[1])) seen.set(match[1], next++);
  }
  return seen;
}

const tasks = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8')).tasks;
const results = [];

for (const task of tasks) {
  const cwd = join(worktrees, task.id);
  for (const verb of VERBS) {
    if (verb.skipWhen?.(task)) continue;
    const started = process.hrtime.bigint();
    let stdout = '';
    let failed = null;
    try {
      ({ stdout } = await run(ripwire, verb.args(task), { cwd, maxBuffer: 64 * 1024 * 1024 }));
    } catch (error) {
      failed = String(error?.message ?? error).slice(0, 200);
      stdout = String(error?.stdout ?? '');
    }
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const ranks = rankPaths(stdout);
    const hits = task.ground_truth.map((path) => ({ path, rank: ranks.get(path) ?? null }));
    const found = hits.filter((hit) => hit.rank !== null);
    results.push({
      task: task.id,
      verb: verb.id,
      failed,
      ms: Math.round(ms),
      bytes: Buffer.byteLength(stdout),
      est_tokens: Math.round(Buffer.byteLength(stdout) / 4),
      paths_mentioned: ranks.size,
      ground_truth: task.ground_truth.length,
      hits: found.length,
      recall: Number((found.length / task.ground_truth.length).toFixed(3)),
      best_rank: found.length ? Math.min(...found.map((hit) => hit.rank)) : null,
      per_file: hits,
    });
    process.stderr.write(
      `${task.id}/${verb.id}: ${found.length}/${task.ground_truth.length} in ${Buffer.byteLength(stdout)} B\n`,
    );
  }
}

writeFileSync(
  outPath,
  `${JSON.stringify({ generated: new Date().toISOString(), results }, null, 2)}\n`,
);
console.log(outPath);
