import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  IOS_SNAPSHOT_ENGINE_FILE,
  IOS_SNAPSHOT_RUNNER_FILE,
  iosSnapshotEngineOwnershipViolations,
} from './ios-snapshot-engine-policy.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

function sources(overrides: ReadonlyMap<string, string> = new Map()) {
  return [IOS_SNAPSHOT_ENGINE_FILE, IOS_SNAPSHOT_RUNNER_FILE].map((file) => ({
    path: file,
    source: overrides.get(file) ?? fs.readFileSync(path.join(repoRoot, file), 'utf8'),
  }));
}

test('the iOS snapshot engine owns each presentation boundary exactly once', () => {
  assert.deepEqual(iosSnapshotEngineOwnershipViolations(sources()), []);
});

test('the structural gate rejects a planted duplicate acquired presentation', () => {
  const engine = fs.readFileSync(path.join(repoRoot, IOS_SNAPSHOT_ENGINE_FILE), 'utf8');
  const planted = engine.replace(
    'return presentAcquiredSnapshot(input.acquisition, request, foldPolicy);',
    'return presentAcquiredSnapshot(input.acquisition, request, foldPolicy);\n  presentAcquiredSnapshot(input.acquisition, request, foldPolicy);',
  );
  assert.notEqual(planted, engine);
  const violations = iosSnapshotEngineOwnershipViolations(
    sources(new Map([[IOS_SNAPSHOT_ENGINE_FILE, planted]])),
  );
  assert.ok(
    violations.some((violation) => violation.message.includes('presentAcquiredSnapshot exactly 1')),
    JSON.stringify(violations),
  );
});
