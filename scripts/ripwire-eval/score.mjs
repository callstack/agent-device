#!/usr/bin/env node
// Scores the agent half of the ripwire evaluation.
//
// Each run file under --runs is one subagent's answer for one (task, arm, replicate). A run is
// scored against the task's ground truth — the file list of the real merged commit the task
// replays — as file-level recall, precision and F1. Files listed in a task's `excluded` set
// (generated ledgers and fixtures) are dropped from a prediction rather than counted against it.
//
// Usage: node scripts/ripwire-eval/score.mjs --runs=<dir> [--out=<file>]

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const hit = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const runsDir = arg('runs');
const outPath = arg('out', join(here, 'agent-results.json'));
if (!runsDir) {
  console.error('usage: score.mjs --runs=<dir> [--out=<file>]');
  process.exit(2);
}

const tasks = new Map(
  JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8')).tasks.map((task) => [task.id, task]),
);

function f1(recall, precision) {
  return recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);
}

const scored = readdirSync(runsDir)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => {
    const run = JSON.parse(readFileSync(join(runsDir, name), 'utf8'));
    const task = tasks.get(run.task);
    if (!task) throw new Error(`run ${name} names unknown task ${run.task}`);

    const excluded = new Set(task.excluded ?? []);
    // The commit's whole change set: files it modified plus files it created. Predicting that a
    // change needs a new test file beside an existing module is part of localizing it.
    const truth = new Set([...task.ground_truth, ...(task.added_files ?? [])]);
    const predicted = [...new Set([...(run.files ?? []), ...(run.new_files ?? [])])].filter(
      (path) => !excluded.has(path),
    );
    const hit = predicted.filter((path) => truth.has(path));
    const recall = hit.length / truth.size;
    const precision = predicted.length === 0 ? 0 : hit.length / predicted.length;

    const added = new Set(task.added_files ?? []);
    const addedHit = (run.new_files ?? []).filter((path) => added.has(path)).length;

    return {
      run: name.replace(/\.json$/, ''),
      task: run.task,
      arm: run.arm,
      rep: run.rep,
      ground_truth: truth.size,
      predicted: predicted.length,
      hit: hit.length,
      recall: Number(recall.toFixed(3)),
      precision: Number(precision.toFixed(3)),
      f1: Number(f1(recall, precision).toFixed(3)),
      new_files_expected: added.size,
      new_files_hit: addedHit,
      subagent_tokens: run.subagent_tokens ?? null,
      tool_uses: run.tool_uses ?? null,
      duration_ms: run.duration_ms ?? null,
      files_opened: (run.files_opened ?? []).length,
      missed: [...truth].filter((path) => !predicted.includes(path)),
      spurious: predicted.filter((path) => !truth.has(path)),
    };
  });

function mean(values) {
  const usable = values.filter((value) => typeof value === 'number');
  return usable.length
    ? Number((usable.reduce((a, b) => a + b, 0) / usable.length).toFixed(3))
    : null;
}

const byArm = {};
for (const arm of new Set(scored.map((entry) => entry.arm))) {
  const rows = scored.filter((entry) => entry.arm === arm);
  byArm[arm] = {
    runs: rows.length,
    recall: mean(rows.map((r) => r.recall)),
    precision: mean(rows.map((r) => r.precision)),
    f1: mean(rows.map((r) => r.f1)),
    subagent_tokens: mean(rows.map((r) => r.subagent_tokens)),
    tool_uses: mean(rows.map((r) => r.tool_uses)),
    duration_ms: mean(rows.map((r) => r.duration_ms)),
    files_opened: mean(rows.map((r) => r.files_opened)),
  };
}

const byTask = {};
for (const id of tasks.keys()) {
  const rows = scored.filter((entry) => entry.task === id);
  if (!rows.length) continue;
  byTask[id] = {};
  for (const arm of new Set(rows.map((entry) => entry.arm))) {
    const armRows = rows.filter((entry) => entry.arm === arm);
    byTask[id][arm] = {
      recall: mean(armRows.map((r) => r.recall)),
      precision: mean(armRows.map((r) => r.precision)),
      f1: mean(armRows.map((r) => r.f1)),
      subagent_tokens: mean(armRows.map((r) => r.subagent_tokens)),
      tool_uses: mean(armRows.map((r) => r.tool_uses)),
      duration_ms: mean(armRows.map((r) => r.duration_ms)),
    };
  }
}

writeFileSync(
  outPath,
  `${JSON.stringify({ generated: new Date().toISOString(), by_arm: byArm, by_task: byTask, runs: scored }, null, 2)}\n`,
);

for (const entry of scored) {
  console.log(
    `${entry.run.padEnd(20)} R=${entry.recall.toFixed(2)} P=${entry.precision.toFixed(2)} F1=${entry.f1.toFixed(2)} tok=${entry.subagent_tokens} calls=${entry.tool_uses}`,
  );
}
console.log('\nby arm:', JSON.stringify(byArm, null, 2));
