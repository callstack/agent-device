// Exercises the layer-3 Maestro version probe end to end: the script the conformance workflow step
// runs, against fixture executables on PATH, so each verdict is proven by a real subprocess exit
// code and real output rather than a stub of itself (#4455).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import {
  MAX_DIAGNOSTIC_BYTES,
  evaluateVersionProbe,
  parseVersion,
  readPinnedVersion,
} from './verify-cli-version.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts/maestro-conformance/verify-cli-version.mjs');
const workflowPath = path.join(repoRoot, '.github/workflows/conformance-differential.yml');
const PIN = readPinnedVersion();

function scratchDirectory(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  test.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return root;
}

/**
 * Runs the real probe script with a fixture `maestro` first on PATH — so it shadows any real CLI
 * the host has — that prints `stdout` and `stderr` and exits `exitCode`.
 */
function runProbe({ exitCode = 0, stdout = '', stderr = '' } = {}) {
  const root = scratchDirectory('maestro-version-probe-');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const stdoutFile = path.join(root, 'stdout.txt');
  const stderrFile = path.join(root, 'stderr.txt');
  fs.writeFileSync(stdoutFile, stdout);
  fs.writeFileSync(stderrFile, stderr);
  const fixture = path.join(bin, 'maestro');
  fs.writeFileSync(
    fixture,
    '#!/bin/sh\n' +
      `cat ${JSON.stringify(stdoutFile)}\n` +
      `cat ${JSON.stringify(stderrFile)} >&2\n` +
      `exit ${exitCode}\n`,
  );
  fs.chmodSync(fixture, 0o755);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    // The fixture directory comes first, so it shadows a real `maestro` the host may have.
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
  });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

function completedProbe(overrides) {
  return {
    command: 'maestro',
    args: ['--version'],
    spawnErrorCode: undefined,
    exitCode: 0,
    signal: null,
    stdout: { value: '', bytes: 0, totalBytes: 0, droppedBytes: 0 },
    stderr: { value: '', bytes: 0, totalBytes: 0, droppedBytes: 0 },
    ...overrides,
  };
}

function streamOf(value) {
  return { value, bytes: value.length, totalBytes: value.length, droppedBytes: 0 };
}

test(`stdout notices around the pinned ${PIN} still match the pin`, () => {
  const run = runProbe({
    stdout:
      'Thank you for using Maestro! Analytics is disabled.\n' +
      `Maestro 2.0.0 installed 2026-01-02\n===\n${PIN}\n`,
  });
  assert.equal(run.status, 0, run.output);
  assert.match(run.stdout, new RegExp(`expected=${PIN} actual=${PIN}`));
  assert.match(run.stdout, /verdict=match \(reports the pinned version\)/);
  assert.doesNotMatch(run.output, /::error::/);
});

test('a probe whose newest semver is not the pin is a mismatch naming both sides', () => {
  const run = runProbe({ stdout: `${PIN}\n1.2.3\n` });
  assert.equal(run.status, 1);
  // The last semver wins: the same half of the output `grep | tail -1` read.
  assert.match(run.stdout, new RegExp(`expected=${PIN} actual=1\\.2\\.3`));
  assert.match(run.stdout, /verdict=version-mismatch \(reports a different Maestro version\)/);
  assert.match(
    run.stdout,
    /::error::Layer-3 Maestro CLI check failed with verdict version-mismatch/,
  );
});

test('empty stdout is reported as a probe that printed nothing', () => {
  const run = runProbe();
  assert.equal(run.status, 1);
  assert.match(run.stdout, new RegExp(`expected=${PIN} actual=$`, 'm'));
  assert.match(run.stdout, /verdict=missing-version \(printed no stdout at all\)/);
  assert.match(run.stdout, /maestro --version stdout .*\n\(empty\)/s);
});

test('stdout without a version is reported as unparseable, not as a mismatch', () => {
  const run = runProbe({ stdout: 'usage: maestro <command>\n' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /verdict=unparseable-version \(printed no version-shaped text\)/);
  assert.match(run.stdout, /usage: maestro <command>/);
});

test('a nonzero exit is a command failure even when stdout prints the pinned version', () => {
  const stderr = 'Fatal error: could not start JVM\n';
  const run = runProbe({ exitCode: 1, stdout: `${PIN}\n`, stderr });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /verdict=command-failed \(did not complete successfully\)/);
  // Exactly what the discarded-stderr masked pipeline lost: the exit code and the CLI's reason.
  assert.match(run.stdout, /exit=1 signal=- spawnError=-/);
  assert.match(run.output, /Fatal error: could not start JVM/);
  assert.match(
    run.stderr,
    new RegExp(
      `maestro --version stderr \\(retained the last ${stderr.length} of ${stderr.length} bytes\\)`,
    ),
  );
});

test('an absent executable reports the spawn failure instead of a blank actual', () => {
  const root = scratchDirectory('maestro-version-probe-absent-');
  const run = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    // Only the system directories, and no `maestro` anywhere on them.
    env: { ...process.env, PATH: path.join(root, 'bin') },
  });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /verdict=command-failed \(did not complete successfully\)/);
  assert.match(run.stdout, /spawnError=ENOENT/);
});

test('oversized output is retained only up to its bounded tail and names what it dropped', () => {
  const filler = 'x'.repeat(MAX_DIAGNOSTIC_BYTES * 3);
  const run = runProbe({ exitCode: 1, stdout: `${PIN}\n`, stderr: `${filler}\nEND OF FAILURE\n` });
  assert.equal(run.status, 1);
  assert.match(run.output, /END OF FAILURE/);
  assert.match(
    run.stderr,
    new RegExp(`retained the last ${MAX_DIAGNOSTIC_BYTES} of \\d+ bytes, dropped \\d+`),
  );
  assert.ok(run.output.length < MAX_DIAGNOSTIC_BYTES * 2, 'the step log stays bounded');
});

test('a probe that did not complete cleanly is never accepted on the strength of its stdout', () => {
  const stdout = streamOf(`${PIN}\n`);
  assert.equal(evaluateVersionProbe(completedProbe({ stdout }), PIN).outcome, 'match');
  assert.equal(
    evaluateVersionProbe(completedProbe({ stdout, exitCode: 7 }), PIN).outcome,
    'command-failed',
  );
  assert.equal(
    evaluateVersionProbe(completedProbe({ stdout, exitCode: null, signal: 'SIGTERM' }), PIN)
      .outcome,
    'command-failed',
  );
  assert.equal(
    evaluateVersionProbe(
      completedProbe({ stdout, exitCode: null, signal: null, spawnErrorCode: 'ENOENT' }),
      PIN,
    ).outcome,
    'command-failed',
  );
});

test('the version match takes the last semver and tolerates notices', () => {
  assert.equal(parseVersion(`banner 1.0.0\n${PIN}\nsee 2.9.9 notes`), '2.9.9');
  assert.equal(parseVersion('no version here'), null);
});

test('the workflow step runs the probe script instead of a masked pipeline', () => {
  const workflow = parse(fs.readFileSync(workflowPath, 'utf8'));
  const steps = workflow.jobs['differential-ios'].steps;
  const step = steps.find(
    (candidate) => candidate.name === 'Verify the Maestro CLI matches the oracle pin',
  );
  assert.ok(step, 'the pin check step must exist');
  assert.match(step.run, /scripts\/maestro-conformance\/verify-cli-version\.mjs/);
  // The two edits that made the November 9 run undiagnosable must not come back.
  assert.doesNotMatch(step.run, /2>\/dev\/null/);
  assert.doesNotMatch(step.run, /\|\| true/);
});
