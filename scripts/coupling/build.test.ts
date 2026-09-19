import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

function runCli(...args: string[]) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', 'scripts/coupling/build.ts', ...args],
    { cwd: repoRoot, encoding: 'utf8' },
  );
}

test('writes the report JSON with the declared shape and prints the summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coupling-build-'));
  try {
    const out = join(dir, 'report.json');
    const result = runCli('--since-days', '30', '--out', out);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(Object.keys(report), [
      'generated',
      'window',
      'assortativity',
      'perFamily',
      'hubs',
      'familyPairs',
      'edges',
    ]);
    assert.deepEqual(Object.keys(report.window), ['sinceDays', 'since', 'allTime']);
    assert.equal(report.window.sinceDays, 30);
    assert.deepEqual(Object.keys(report.perFamily[0]), [
      'family',
      'files',
      'inWeight',
      'outWeight',
      'outInFlow',
      'partners',
      'Q',
    ]);
    assert.ok(result.stdout.includes('Change coupling:'));
    assert.ok(result.stdout.includes('used for pairs'));
    assert.ok(result.stdout.includes('modularity'));
    assert.ok(result.stdout.includes('top coupling hubs'));
    assert.ok(result.stdout.includes(`wrote ${out.startsWith(repoRoot) ? '' : '..'}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects a malformed flag with usage and a non-zero exit', () => {
  const result = runCli('--since-days', 'soon');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--since-days expects a positive integer/);
  assert.match(result.stderr, /Usage: pnpm coupling/);
});
