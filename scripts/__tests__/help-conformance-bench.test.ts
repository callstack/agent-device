import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'vitest';

const execFileAsync = promisify(execFile);
const SCRIPT = join(import.meta.dirname, '..', 'help-conformance-bench.mjs');

// These tests spawn the real script in --dry-run mode with every required doc
// overridden, so no LLM call and no built CLI is needed: the raw-first-screen
// case's only doc is --help:first30, and the override replaces the shell-out.

async function runBench(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [SCRIPT, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const payload = error as { code?: number; stdout?: string; stderr?: string };
    return { code: payload.code ?? 1, stdout: payload.stdout ?? '', stderr: payload.stderr ?? '' };
  }
}

async function readDryRunPrompt(outDir: string): Promise<string> {
  const reportName = (await readdir(outDir)).find((name) => name.startsWith('report-'));
  assert.ok(reportName, 'dry-run must write a report file');
  const report = JSON.parse(await readFile(join(outDir, reportName), 'utf8')) as Array<{
    prompt: string;
  }>;
  assert.ok(report.length > 0 && typeof report[0]?.prompt === 'string');
  return report[0].prompt;
}

// Guards the --override-doc contract: an override swaps only WHERE the doc
// text comes from, never how it is sliced. The --help:first30 doc id caps the
// live `--help` output at 30 lines, so an override longer than that must be
// capped identically or the A/B comparison grades content a live run never
// shows (the exact bug found in review of the initial version).
test('override for --help:first30 goes through the same 30-line cap as the live doc', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'help-bench-'));
  const draftPath = join(dir, 'draft-help.txt');
  const lines = Array.from({ length: 49 }, (_, i) => `draft help line ${i + 1}`);
  await writeFile(draftPath, lines.join('\n'));
  const run = await runBench([
    '--dry-run',
    '--case',
    'raw-first-screen-bluesky',
    '--runner',
    'claude:test-model',
    '--override-doc',
    `--help:first30=${draftPath}`,
    '--out',
    dir,
  ]);
  assert.equal(run.code, 0, run.stderr);
  const prompt = await readDryRunPrompt(dir);
  assert.ok(prompt.includes('draft help line 30'), 'line 30 is inside the cap and must survive');
  assert.ok(!prompt.includes('draft help line 31'), 'line 31 is past the cap and must be cut');
});

test('an override topic id no selected case uses fails fast and lists valid doc ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'help-bench-'));
  const draftPath = join(dir, 'draft.txt');
  await writeFile(draftPath, 'irrelevant');
  const run = await runBench([
    '--dry-run',
    '--case',
    'raw-first-screen-bluesky',
    '--override-doc',
    `totally-bogus-topic=${draftPath}`,
    '--out',
    dir,
  ]);
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /totally-bogus-topic/);
  assert.match(run.stderr, /Valid doc ids: --help:first30/);
  assert.equal(
    (await readdir(dir)).some((name) => name.startsWith('report-')),
    false,
  );
});

test('a missing override file reports one clean error line, not a stack trace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'help-bench-'));
  const run = await runBench([
    '--dry-run',
    '--case',
    'raw-first-screen-bluesky',
    '--override-doc',
    `--help:first30=${join(dir, 'does-not-exist.txt')}`,
    '--out',
    dir,
  ]);
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /--override-doc file for "--help:first30" is not readable/);
  assert.doesNotMatch(run.stderr, /at .*help-conformance-bench\.mjs/);
});

test('repeated overrides for the same topic id are last-wins', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'help-bench-'));
  const firstPath = join(dir, 'first.txt');
  const secondPath = join(dir, 'second.txt');
  await writeFile(firstPath, 'first draft body');
  await writeFile(secondPath, 'second draft body');
  const run = await runBench([
    '--dry-run',
    '--case',
    'raw-first-screen-bluesky',
    '--runner',
    'claude:test-model',
    '--override-doc',
    `--help:first30=${firstPath}`,
    '--override-doc',
    `--help:first30=${secondPath}`,
    '--out',
    dir,
  ]);
  assert.equal(run.code, 0, run.stderr);
  const prompt = await readDryRunPrompt(dir);
  assert.ok(prompt.includes('second draft body'));
  assert.ok(!prompt.includes('first draft body'));
});
