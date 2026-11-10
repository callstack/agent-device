import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { afterAll, inject } from 'vitest';
import type { ContractCoverageEntry } from './coverage-manifest.ts';

// Setup file for the interaction-contract project. Every `<name>.contract.test.ts` must have a
// sibling `<name>.coverage.ts` manifest, and every scenario the manifest claims must be a test in
// that file that ran. A skipped or todo test proves nothing, so only executed tests count.

const CONTRACT_SUFFIX = '.contract.test.ts';
const EXECUTING_MODES: ReadonlySet<string> = new Set(['run', 'only']);

type CollectedTask = {
  type: string;
  name: string;
  mode: string;
  tasks?: readonly CollectedTask[];
};

function executedTestNames(tasks: readonly CollectedTask[], names: Set<string> = new Set()) {
  for (const task of tasks) {
    if (task.type === 'test' && EXECUTING_MODES.has(task.mode)) names.add(task.name);
    if (task.tasks) executedTestNames(task.tasks, names);
  }
  return names;
}

async function loadManifest(manifestPath: string): Promise<readonly ContractCoverageEntry[]> {
  const exported = Object.values(
    (await import(pathToFileURL(manifestPath).href)) as Record<string, unknown>,
  );
  assert.equal(exported.length, 1, `${manifestPath} must export exactly one coverage manifest`);
  return exported[0] as readonly ContractCoverageEntry[];
}

// oxlint-disable-next-line no-empty-pattern -- Vitest parses a destructured first argument to reach the suite
afterAll(async ({}, suite) => {
  const file = suite.file;
  if (!file.filepath.endsWith(CONTRACT_SUFFIX)) return;
  const manifestPath = file.filepath.slice(0, -CONTRACT_SUFFIX.length) + '.coverage.ts';
  assert.ok(fs.existsSync(manifestPath), `${file.filepath} has no sibling coverage manifest`);
  const coverage = await loadManifest(manifestPath);
  // A name filter skips unmatched scenarios on purpose; the diff would report them all.
  if (inject('interactionContractNameFilter')) return;
  const executed = executedTestNames(file.tasks as readonly CollectedTask[]);
  const unregistered = coverage
    .filter((entry) => !executed.has(entry.scenario))
    .map((entry) => `${entry.path}/${entry.guarantee}: ${entry.scenario}`);
  assert.deepEqual(unregistered, [], 'manifest claims with no executed contract scenario');
});
