import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTest } from '../../src/__tests__/test-utils/tmp-dir.ts';
import {
  assertBenchmarkOwner,
  assertOwnedDerivedPath,
  clearDerivedData,
  createBenchmarkStateRoot,
} from './state-ownership.ts';

test('clears only a benchmark-owned derived-data descendant', () => {
  const stateDir = createBenchmarkStateRoot();
  const derivedPath = path.join(stateDir, 'derived-data', 'cold', 'quiet');
  fs.mkdirSync(derivedPath, { recursive: true });
  fs.writeFileSync(path.join(derivedPath, 'result'), 'fixture');
  clearDerivedData(derivedPath, stateDir);
  assert.equal(fs.existsSync(derivedPath), false);
  assert.throws(
    () => assertOwnedDerivedPath(path.join(stateDir, '..', 'outside'), stateDir),
    /descendant of the benchmark state directory/,
  );
});

test('rejects an unmarked existing root and symlinked ownership marker', async () => {
  const unmarked = await mkdtempForTest('agent-device-ios-benchmark-unmarked-');
  assert.throws(() => assertBenchmarkOwner(unmarked), /not benchmark-owned/);

  const marked = createBenchmarkStateRoot();
  const marker = path.join(marked, '.agent-device-ios-snapshot-benchmark-owner');
  const replacement = path.join(marked, 'marker-target');
  fs.writeFileSync(replacement, 'agent-device-ios-snapshot-benchmark.v1\n');
  fs.rmSync(marker);
  fs.symlinkSync(replacement, marker);
  assert.throws(() => assertBenchmarkOwner(marked), /regular file/);
});
