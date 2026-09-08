#!/usr/bin/env node
// Deterministic half of the ripwire evaluation: no model in the loop.
//
// For every task in tasks.json it runs one ripwire verb against the worktree pinned at the
// task's parent commit and asks a single question — does this one call surface the files the
// real change touched, and what does the answer cost? Ranks come from the order paths first
// appear in ripwire's output, which is its own ranking order.
//
// Recall here is over the change's EXISTING files only (`ground_truth`), not the whole change set:
// a retrieval verb ranks what the tree contains, so a file the commit created is not a hit it
// could have scored. The agent A/B scores the whole set, added files included, and the two
// denominators are therefore different on purpose.
//
// Usage: node scripts/ripwire-eval/retrieval-bench.mjs --ripwire=<bin> --worktrees=<dir> [--out=<file>]

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harnessDir, loadTasks, readArgs, runRipwire } from './bench-cli.mjs';

const { ripwire, worktrees, out } = readArgs({
  usage: 'retrieval-bench.mjs --ripwire=<bin> --worktrees=<dir> [--out=<file>]',
  required: ['ripwire', 'worktrees'],
  optional: { out: join(harnessDir, 'retrieval-results.json') },
});

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

const results = [];

for (const task of loadTasks()) {
  for (const verb of VERBS) {
    if (verb.skipWhen?.(task)) continue;
    const call = await runRipwire(ripwire, verb.args(task), join(worktrees, task.id));
    const ranks = rankPaths(call.stdout);
    const hits = task.ground_truth.map((path) => ({ path, rank: ranks.get(path) ?? null }));
    const found = hits.filter((hit) => hit.rank !== null);
    results.push({
      task: task.id,
      verb: verb.id,
      failed: call.failed,
      ms: call.ms,
      bytes: call.bytes,
      est_tokens: Math.round(call.bytes / 4),
      paths_mentioned: ranks.size,
      ground_truth: task.ground_truth.length,
      ground_truth_basis: 'existing-files-only',
      hits: found.length,
      recall: Number((found.length / task.ground_truth.length).toFixed(3)),
      best_rank: found.length ? Math.min(...found.map((hit) => hit.rank)) : null,
      per_file: hits,
    });
    process.stderr.write(
      `${task.id}/${verb.id}: ${found.length}/${task.ground_truth.length} in ${call.bytes} B\n`,
    );
  }
}

writeFileSync(
  out,
  `${JSON.stringify({ generated: new Date().toISOString(), results }, null, 2)}\n`,
);
console.log(out);
