import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runCmdSync } from '@agent-device/host-kit/command';
import { DryRunStatus } from '@stryker-mutator/api/test-runner';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { COVERAGE_CAPTURE_ENV } from './coverage-reporter.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');

test('Stryker loads the coverage reporter without TypeScript flags and captures a real dry run', () => {
  const root = fs.realpathSync(mkdtempForTestSync('mutation-reporter-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, 'src/decision.js'), 'export const value = true;');
  const marker = path.join(root, 'tested');
  fs.writeFileSync(
    path.join(root, 'decision.test.mjs'),
    `import assert from 'node:assert/strict'; import fs from 'node:fs'; import { value } from './src/decision.js'; assert.equal(value, true); fs.writeFileSync(${JSON.stringify(marker)}, 'tested');`,
  );
  const capture = path.join(root, 'coverage.json');
  const config = path.join(root, 'stryker.config.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      mutate: ['src/decision.js'],
      plugins: [],
      appendPlugins: [path.join(repoRoot, 'scripts/mutation/coverage-reporter.mjs')],
      testRunner: 'command',
      commandRunner: { command: 'node --test decision.test.mjs' },
      coverageAnalysis: 'off',
      concurrency: 1,
      dryRunOnly: true,
      reporters: ['scope-coverage'],
      logLevel: 'fatal',
    }),
  );
  const result = runCmdSync(
    'node',
    [path.join(repoRoot, 'node_modules/@stryker-mutator/core/bin/stryker.js'), 'run', config],
    {
      cwd: root,
      allowFailure: true,
      env: {
        ...process.env,
        NODE_OPTIONS: undefined,
        NODE_TEST_CONTEXT: undefined,
        NODE_TEST_WORKER_ID: undefined,
        [COVERAGE_CAPTURE_ENV]: capture,
      },
    },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(fs.existsSync(marker), result.stdout + result.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'tested');
  assert.equal(JSON.parse(fs.readFileSync(capture, 'utf8')).result.status, DryRunStatus.Complete);
});
