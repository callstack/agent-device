import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ContractCoverageEntry } from './coverage-manifest.ts';

type CollectedTask = {
  type: string;
  name: string;
  mode: string;
  tasks?: readonly CollectedTask[];
};

// A skipped or todo test proves nothing, so only tests that execute count as registered.
const EXECUTING_MODES: ReadonlySet<string> = new Set(['run', 'only']);

function registeredTestNames(tasks: readonly CollectedTask[], names: Set<string> = new Set()) {
  for (const task of tasks) {
    if (task.type === 'test' && EXECUTING_MODES.has(task.mode)) names.add(task.name);
    if (task.tasks) registeredTestNames(task.tasks, names);
  }
  return names;
}

/**
 * Registers one test that fails when a manifest claim names no test in the calling file.
 * Call it once per contract file, after its scenarios are registered.
 */
export function assertCoverageClaimsRegistered(coverage: readonly ContractCoverageEntry[]): void {
  const pathId = coverage[0]?.path ?? 'unknown';
  test(`${pathId} coverage claims each name a registered contract scenario`, ({ task }) => {
    const registered = registeredTestNames(task.file.tasks);
    const unregistered = coverage
      .filter((entry) => !registered.has(entry.scenario))
      .map((entry) => `${entry.path}/${entry.guarantee}: ${entry.scenario}`);
    assert.deepEqual(unregistered, [], 'manifest claims with no registered contract scenario');
  });
}
