#!/usr/bin/env node
// Scores the agent half of the ripwire evaluation.
//
// Each run file under --runs is one subagent's answer for one (task, arm, replicate). A run is
// scored against the task's ground truth — the file list of the real merged commit the task
// replays — as file-level recall, precision and F1. Files listed in a task's `excluded` set
// (generated ledgers and fixtures) are dropped from a prediction rather than counted against it.
//
// Usage: node scripts/ripwire-eval/score.mjs --runs=<dir> [--worktrees=<dir>] [--out=<file>]

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harnessDir, loadTasks, readArgs } from './bench-cli.mjs';

const {
  runs: runsDir,
  worktrees,
  out,
} = readArgs({
  usage: 'score.mjs --runs=<dir> [--worktrees=<dir>] [--out=<file>]',
  required: ['runs'],
  // Given the per-task clones, each run also reports the byte size of the files it opened — a
  // context-cost measure that does not depend on the agent self-reporting one.
  optional: { worktrees: '', out: join(harnessDir, 'agent-results.json') },
});

const tasks = new Map(loadTasks().map((task) => [task.id, task]));

function f1(recall, precision) {
  return recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);
}

function openedPaths(run) {
  return Array.isArray(run.files_opened) ? run.files_opened : [];
}

function openedBytes(root, run) {
  let total = 0;
  for (const path of openedPaths(run)) {
    try {
      total += statSync(join(root, run.task, path)).size;
    } catch {
      // A path the agent named that does not resolve in the pinned clone contributes nothing.
    }
  }
  return total;
}

/** The commit's whole change set: files it modified plus files it created. */
function truthOf(task) {
  return new Set([...task.ground_truth, ...(task.added_files ?? [])]);
}

/** What the run claims, minus the generated files the task excludes from scoring either way. */
function predictionOf(run, task) {
  const excluded = new Set(task.excluded ?? []);
  return [...new Set([...(run.files ?? []), ...(run.new_files ?? [])])].filter(
    (path) => !excluded.has(path),
  );
}

// The runtime-reported cost fields, carried through as numbers or as null when a run predates one.
const REPORTED_COST = ['subagent_tokens', 'tool_uses', 'duration_ms'];

function numberOrNull(value) {
  return typeof value === 'number' ? value : null;
}

/** What the answer cost to produce, as the runtime reported it — never the agent's own estimate. */
function costOf(run) {
  return {
    ...Object.fromEntries(REPORTED_COST.map((key) => [key, numberOrNull(run[key])])),
    files_opened: openedPaths(run).length,
    files_opened_bytes: worktrees ? openedBytes(worktrees, run) : null,
  };
}

/** How close the answer came: the three rates plus the sets behind them. */
function accuracyOf(run, task) {
  const truth = truthOf(task);
  const predicted = predictionOf(run, task);
  const hit = predicted.filter((path) => truth.has(path));
  const recall = hit.length / truth.size;
  const precision = predicted.length === 0 ? 0 : hit.length / predicted.length;
  const added = new Set(task.added_files ?? []);

  return {
    ground_truth: truth.size,
    predicted: predicted.length,
    hit: hit.length,
    recall: Number(recall.toFixed(3)),
    precision: Number(precision.toFixed(3)),
    f1: Number(f1(recall, precision).toFixed(3)),
    new_files_expected: added.size,
    new_files_hit: (run.new_files ?? []).filter((path) => added.has(path)).length,
    missed: [...truth].filter((path) => !predicted.includes(path)),
    spurious: predicted.filter((path) => !truth.has(path)),
  };
}

function scoreRun(name, run, task) {
  const { missed, spurious, ...rates } = accuracyOf(run, task);
  return {
    run: name.replace(/\.json$/, ''),
    task: run.task,
    arm: run.arm,
    rep: run.rep,
    ...rates,
    ...costOf(run),
    missed,
    spurious,
  };
}

const scored = readdirSync(runsDir)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => {
    const run = JSON.parse(readFileSync(join(runsDir, name), 'utf8'));
    const task = tasks.get(run.task);
    if (!task) throw new Error(`run ${name} names unknown task ${run.task}`);
    return scoreRun(name, run, task);
  });

function mean(values) {
  const usable = values.filter((value) => typeof value === 'number');
  return usable.length
    ? Number((usable.reduce((a, b) => a + b, 0) / usable.length).toFixed(3))
    : null;
}

const AGGREGATED = [
  'recall',
  'precision',
  'f1',
  'subagent_tokens',
  'tool_uses',
  'duration_ms',
  'files_opened',
  'files_opened_bytes',
];

function summarize(rows) {
  return Object.fromEntries(AGGREGATED.map((key) => [key, mean(rows.map((row) => row[key]))]));
}

const byArm = {};
for (const arm of new Set(scored.map((entry) => entry.arm))) {
  const rows = scored.filter((entry) => entry.arm === arm);
  byArm[arm] = { runs: rows.length, ...summarize(rows) };
}

const byTask = {};
for (const id of tasks.keys()) {
  const rows = scored.filter((entry) => entry.task === id);
  if (rows.length === 0) continue;
  byTask[id] = Object.fromEntries(
    [...new Set(rows.map((entry) => entry.arm))].map((arm) => [
      arm,
      summarize(rows.filter((entry) => entry.arm === arm)),
    ]),
  );
}

writeFileSync(
  out,
  `${JSON.stringify({ generated: new Date().toISOString(), by_arm: byArm, by_task: byTask, runs: scored }, null, 2)}\n`,
);

for (const entry of scored) {
  console.log(
    `${entry.run.padEnd(20)} R=${entry.recall.toFixed(2)} P=${entry.precision.toFixed(2)} F1=${entry.f1.toFixed(2)} tok=${entry.subagent_tokens} calls=${entry.tool_uses}`,
  );
}
console.log('\nby arm:', JSON.stringify(byArm, null, 2));
