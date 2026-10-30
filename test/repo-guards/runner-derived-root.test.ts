import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { REPO_ROOT } from '@agent-device/test-kit';
import { resolveRunnerScriptDefaultDerivedPath } from '@agent-device/platform-apple/runner/operations';

test('the script derived root agrees with the runner cache owner', () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, 'packages/apple-runner/src/runner-cache-metadata.ts'),
    'utf8',
  );
  const root = source.match(
    /const RUNNER_DERIVED_ROOT = path\.join\(os\.homedir\(\), '([^']+)', '([^']+)'\);/,
  );
  assert.ok(root, 'the runner derived root must have a recognizable home-relative layout');
  assert.match(
    source,
    /path\.join\(RUNNER_DERIVED_ROOT, 'derived', resolveRunnerDerivedBaseName\(device\)\)/,
  );
  assert.equal(
    path.join(os.homedir(), root[1], root[2], 'derived'),
    resolveRunnerScriptDefaultDerivedPath('ios', os.homedir()),
  );
});
