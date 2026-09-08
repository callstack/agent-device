#!/usr/bin/env node
// Test-selection half of the ripwire evaluation: no model in the loop.
//
// agent-device's rule is that tests mirror source one-to-one, so "I changed these sources, which
// tests do I run" has a checkable answer. For each task this feeds ripwire the NON-TEST ground
// truth files of the real commit and asks whether the commit's own TEST files come back, and at
// what cost.
//
// Usage: node scripts/ripwire-eval/affected-bench.mjs --ripwire=<bin> --worktrees=<dir> [--out=<file>]

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harnessDir, loadTasks, readArgs, runRipwire } from './bench-cli.mjs';

const { ripwire, worktrees, out } = readArgs({
  usage: 'affected-bench.mjs --ripwire=<bin> --worktrees=<dir> [--out=<file>]',
  required: ['ripwire', 'worktrees'],
  optional: { out: join(harnessDir, 'affected-results.json') },
});

// A test FILE is a harness the runner executes. A file that merely lives in a test location —
// `__tests__/test-utils/fake-adb.ts`, `__tests__/runtime-port-fixtures.ts`, a provider-scenario
// world — is a helper: it is neither a source the change starts from nor a harness `--affected`
// could name, so it is counted in neither column.
const isTestFile = (path) => /\.test\.[cm]?[jt]sx?$/.test(path);
const inTestLocation = (path) => /(^|\/)(__tests__|test)\//.test(path);
const isHelper = (path) => !isTestFile(path) && inTestLocation(path);
// Seeds are code files in a language ripwire builds a call graph for — this repository's ground
// truth reaches TypeScript, .mjs and the Android helper's Java, and a walk seeded from only some
// of a change's sources measures less than the change. Data files (.json, .yaml) carry no call
// edges and are never seeds.
const SEED_EXTENSIONS =
  /\.(?:[cm]?[jt]sx?|java|swift|kt|mm?|c|cc|cpp|h|hpp|py|go|rs|rb|php|cs|sh)$/;
const isSource = (path) => !isTestFile(path) && !isHelper(path) && SEED_EXTENSIONS.test(path);

const results = [];

for (const task of loadTasks()) {
  const added = new Set(task.added_files ?? []);
  const truth = [...task.ground_truth, ...added];
  const sources = truth.filter(isSource);
  // A selector cannot name a file the change has not created yet, so files the commit ADDED are
  // reported separately rather than counted as misses.
  const expected = truth.filter((path) => isTestFile(path) && !added.has(path));
  const expectedAdded = truth.filter((path) => isTestFile(path) && added.has(path));
  const helpers = truth.filter(isHelper);
  if (sources.length === 0 || expected.length === 0) {
    results.push({ task: task.id, skipped: 'no source/test split in ground truth' });
    continue;
  }

  const call = await runRipwire(
    ripwire,
    ['.', `--affected=${sources.join(',')}`],
    join(worktrees, task.id),
  );
  const selected = [...call.stdout.matchAll(/<test p="([^"]+)"/g)].map((match) => match[1]);
  const hit = expected.filter((path) => selected.includes(path));
  results.push({
    task: task.id,
    failed: call.failed,
    ms: call.ms,
    bytes: call.bytes,
    seeds: sources.length,
    selected: selected.length,
    expected: expected.length,
    expected_added_not_scorable: expectedAdded.length,
    helpers_not_scored: helpers,
    hit: hit.length,
    recall: Number((hit.length / expected.length).toFixed(3)),
    // Of the tests it named, how many were actually touched — the cost of running the whole set.
    precision: selected.length === 0 ? 0 : Number((hit.length / selected.length).toFixed(3)),
    missed: expected.filter((path) => !selected.includes(path)),
  });
  process.stderr.write(
    `${task.id}: ${hit.length}/${expected.length} expected tests inside ${selected.length} selected, ${call.bytes} B\n`,
  );
}

writeFileSync(
  out,
  `${JSON.stringify({ generated: new Date().toISOString(), results }, null, 2)}\n`,
);
console.log(out);
