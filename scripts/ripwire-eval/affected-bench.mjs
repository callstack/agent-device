#!/usr/bin/env node
// Test-selection half of the ripwire evaluation: no model in the loop.
//
// agent-device's rule is that tests mirror source one-to-one, so "I changed these sources, which
// tests do I run" has a checkable answer. For each task this feeds ripwire the NON-TEST ground
// truth files of the real commit and asks whether the commit's own TEST files come back, and at
// what cost.
//
// Usage: node scripts/ripwire-eval/affected-bench.mjs --ripwire=<bin> --worktrees=<dir> [--out=<file>]

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
const outPath = arg('out', join(here, 'affected-results.json'));
if (!ripwire || !worktrees) {
  console.error('usage: affected-bench.mjs --ripwire=<bin> --worktrees=<dir> [--out=<file>]');
  process.exit(2);
}

const isTest = (path) => /(\.test\.[cm]?[jt]sx?$)|(^|\/)__tests__\//.test(path);

const tasks = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8')).tasks;
const results = [];

for (const task of tasks) {
  const added = new Set(task.added_files ?? []);
  const truth = [...task.ground_truth, ...added];
  const sources = truth.filter((path) => !isTest(path) && /\.[cm]?[jt]s$/.test(path));
  // A selector cannot name a file the change has not created yet, so files the commit ADDED are
  // reported separately rather than counted as misses.
  const expected = truth.filter((path) => isTest(path) && !added.has(path));
  const expectedAdded = truth.filter((path) => isTest(path) && added.has(path));
  if (sources.length === 0 || expected.length === 0) {
    results.push({ task: task.id, skipped: 'no source/test split in ground truth' });
    continue;
  }

  const started = process.hrtime.bigint();
  let stdout = '';
  let failed = null;
  try {
    ({ stdout } = await run(ripwire, ['.', `--affected=${sources.join(',')}`], {
      cwd: join(worktrees, task.id),
      maxBuffer: 32 * 1024 * 1024,
    }));
  } catch (error) {
    failed = String(error?.message ?? error).slice(0, 200);
    stdout = String(error?.stdout ?? '');
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  const selected = [...stdout.matchAll(/<test p="([^"]+)"/g)].map((match) => match[1]);
  const hit = expected.filter((path) => selected.includes(path));
  results.push({
    task: task.id,
    failed,
    ms: Math.round(ms),
    bytes: Buffer.byteLength(stdout),
    seeds: sources.length,
    selected: selected.length,
    expected: expected.length,
    expected_added_not_scorable: expectedAdded.length,
    hit: hit.length,
    recall: Number((hit.length / expected.length).toFixed(3)),
    // Of the tests it named, how many were actually touched — the cost of running the whole set.
    precision: selected.length === 0 ? 0 : Number((hit.length / selected.length).toFixed(3)),
    missed: expected.filter((path) => !selected.includes(path)),
  });
  process.stderr.write(
    `${task.id}: ${hit.length}/${expected.length} expected tests inside ${selected.length} selected, ${Buffer.byteLength(stdout)} B\n`,
  );
}

writeFileSync(
  outPath,
  `${JSON.stringify({ generated: new Date().toISOString(), results }, null, 2)}\n`,
);
console.log(outPath);
