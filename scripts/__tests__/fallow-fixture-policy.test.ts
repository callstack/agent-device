import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { mkdtempForTest } from '../../src/__tests__/test-utils/tmp-dir.ts';
import { runCmd } from '../../src/utils/exec.ts';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FALLOW_CLI = path.join(REPOSITORY_ROOT, 'node_modules', 'fallow', 'bin', 'fallow');
const FIXTURE_GLOB = '**/*.fixtures.ts';

type IgnoreExportPolicy = {
  file: string;
  exports: string[];
};

type ResolvedFallowConfig = {
  ignorePatterns: string[];
  ignoreExports: IgnoreExportPolicy[];
};

type DeadCodeReport = {
  summary: { unused_exports: number };
  unused_exports: Array<{ path: string; export_name: string }>;
};

type HealthReport = {
  findings: Array<{ path: string; name: string }>;
};

function parseJsonEnvelope<T>(stdout: string): T {
  const jsonStart = stdout.indexOf('{');
  assert.notEqual(jsonStart, -1, `expected JSON output, received: ${stdout}`);
  return JSON.parse(stdout.slice(jsonStart)) as T;
}

async function runFallow(root: string, args: string[]) {
  return await runCmd(process.execPath, [FALLOW_CLI, ...args], {
    cwd: root,
    allowFailure: true,
    timeoutMs: 30_000,
  });
}

test('fixture exports stay exempt while fixture health remains audited', async () => {
  const configResult = await runFallow(REPOSITORY_ROOT, ['config', '--format', 'json', '--quiet']);
  assert.equal(configResult.exitCode, 0, configResult.stderr);
  const resolved = parseJsonEnvelope<ResolvedFallowConfig>(configResult.stdout);
  const fixturePolicy = resolved.ignoreExports.find(({ file }) => file === FIXTURE_GLOB);

  const root = await mkdtempForTest('fallow-fixture-policy-');
  await fs.mkdir(path.join(root, 'src'));
  await Promise.all([
    fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}\n'),
    fs.writeFile(
      path.join(root, 'tsconfig.json'),
      '{"compilerOptions":{"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext"},"include":["src/**/*.ts"]}\n',
    ),
    fs.writeFile(
      path.join(root, 'src', 'index.ts'),
      "import './sample.fixtures.ts';\nexport const entry = true;\n",
    ),
    fs.writeFile(
      path.join(root, 'src', 'sample.fixtures.ts'),
      'export function unusedFixture(value: boolean): number {\n  if (value) return 1;\n  return 0;\n}\n',
    ),
    fs.writeFile(
      path.join(root, '.fallowrc.json'),
      `${JSON.stringify({
        entry: ['src/index.ts'],
        ignorePatterns: resolved.ignorePatterns,
        ignoreExports: fixturePolicy ? [fixturePolicy] : [],
        health: { maxCyclomatic: 1, maxCognitive: 1 },
      })}\n`,
    ),
  ]);

  const deadCodeResult = await runFallow(root, [
    'dead-code',
    '--unused-exports',
    '--format',
    'json',
    '--quiet',
    '--no-cache',
  ]);
  assert.equal(deadCodeResult.exitCode, 0, deadCodeResult.stderr);
  const deadCode = parseJsonEnvelope<DeadCodeReport>(deadCodeResult.stdout);
  assert.equal(deadCode.summary.unused_exports, 0);
  assert.deepEqual(deadCode.unused_exports, []);

  const healthResult = await runFallow(root, [
    'health',
    '--complexity',
    '--format',
    'json',
    '--quiet',
    '--no-cache',
  ]);
  assert.equal(healthResult.exitCode, 1, 'the planted fixture complexity must fail health');
  const health = parseJsonEnvelope<HealthReport>(healthResult.stdout);
  assert.ok(
    health.findings.some(
      ({ path: findingPath, name }) =>
        findingPath === 'src/sample.fixtures.ts' && name === 'unusedFixture',
    ),
    'Fallow health did not analyze the planted fixture',
  );

  assert.equal(resolved.ignorePatterns.includes(FIXTURE_GLOB), false);
  assert.ok(fixturePolicy, `missing ${FIXTURE_GLOB} unused-export policy`);
  assert.deepEqual(fixturePolicy.exports, ['*']);
});
