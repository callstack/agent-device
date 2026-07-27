// Tests of the fuzz harness itself (#1414).
//
// The corpus replay only proves clean inputs pass, so a regressed classifier or watchdog would
// leave every test green. These run the harness against the broken-on-purpose targets through
// the real CLI — same worker, watchdog, artifact, and promotion path a nightly failure takes —
// and require each failure kind to be reported.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkCase } from './invariant.ts';
import { SELF_CHECK_TARGETS } from './self-check-targets.ts';

const FUZZ_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.join(FUZZ_DIR, 'run.ts');

function runHarness(
  args: readonly string[],
  env: Record<string, string> = {},
): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, ['--experimental-strip-types', RUN, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    return { status: failure.status ?? 1, stdout: failure.stdout ?? '' };
  }
}

function targetNamed(name: string) {
  const target = SELF_CHECK_TARGETS.find((candidate) => candidate.name === name);
  if (!target) throw new Error(`missing self-check target ${name}`);
  return target;
}

describe('fuzz invariant classifier', () => {
  it('reports a bare Error as untyped-throw', () => {
    const failure = checkCase(targetNamed('self-check-untyped-throw'), 'case');
    expect(failure?.kind).toBe('untyped-throw');
    expect(failure?.detail).toContain('Error: self-check untyped throw');
  });

  it('reports an AppError with a blank hint as empty-hint', () => {
    const failure = checkCase(targetNamed('self-check-empty-hint'), 'case');
    expect(failure?.kind).toBe('empty-hint');
  });
});

describe('fuzz harness self-check', () => {
  it('catches an untyped throw, an empty hint, and a wedged worker', () => {
    const { status, stdout } = runHarness(['--self-check', '--case-timeout-ms', '750']);
    expect(stdout).toContain('ok   self-check-untyped-throw: expected untyped-throw');
    expect(stdout).toContain('ok   self-check-empty-hint: expected empty-hint');
    expect(stdout).toContain('ok   self-check-hang: expected hang, got hang');
    expect(status).toBe(0);
  });
});

describe('worker startup budget', () => {
  // The watchdog used to start before the worker reported ready, so a slow thread start was
  // misreported as a hung parser case. Startup must not be charged against the case budget.
  it('does not report a hang when worker startup outlasts the case budget', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-startup-'));
    const { stdout } = runHarness(
      [
        '--target',
        'self-check-untyped-throw',
        '--iterations',
        '1',
        '--case-timeout-ms',
        '300',
        '--artifact-dir',
        dir,
      ],
      { AGENT_DEVICE_FUZZ_STARTUP_DELAY_MS: '1200' },
    );
    expect(stdout).toContain('untyped-throw');
    expect(stdout).not.toContain('hang');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('run envelope', () => {
  function envelopeFrom(args: readonly string[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-envelope-'));
    const { status } = runHarness([...args, '--artifact-dir', dir]);
    const file = path.join(dir, 'run-envelope.json');
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.rmSync(dir, { recursive: true, force: true });
    return { envelope, status };
  }

  it('is written for a passing generate run', () => {
    const { envelope, status } = envelopeFrom(['--target', 'selector', '--iterations', '20']);
    expect(status).toBe(0);
    expect(envelope.lane).toBe('parser-fuzz');
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.result).toBe('pass');
    expect(envelope.details.mode).toBe('generate');
    expect(envelope.details.targetRuns[0].target).toBe('selector');
  });

  // A self-check failure must not leave the lane without an envelope: monitoring reads it and
  // the workflow summary prints it on every terminal path.
  it('is written for a failing run too', () => {
    const { envelope, status } = envelopeFrom([
      '--target',
      'self-check-untyped-throw',
      '--iterations',
      '1',
      '--case-timeout-ms',
      '2000',
    ]);
    expect(status).toBe(1);
    expect(envelope.result).toBe('fail');
    expect(envelope.details.failures[0].kind).toBe('untyped-throw');
    expect(envelope.details.reproCommands[0]).toContain('--input-file');
  });

  it('is written for a self-check run', () => {
    const { envelope, status } = envelopeFrom(['--self-check', '--case-timeout-ms', '750']);
    expect(status).toBe(0);
    expect(envelope.result).toBe('pass');
    expect(envelope.details.mode).toBe('self-check');
    expect(envelope.details.targetRuns).toHaveLength(3);
  });
});

describe('artifact promotion', () => {
  it('promotes a saved failing case into the corpus, once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-promote-'));
    const corpus = path.join(dir, 'regressions.json');
    fs.writeFileSync(corpus, '[]\n');
    const artifact = path.join(dir, 'case.json');
    fs.writeFileSync(
      artifact,
      JSON.stringify({
        target: 'self-check-untyped-throw',
        input: 'promote me',
        kind: 'untyped-throw',
        detail: 'seeded',
      }),
    );
    const env = { AGENT_DEVICE_FUZZ_CORPUS: corpus };

    const first = runHarness(['--input-file', artifact, '--append-corpus'], env);
    expect(first.stdout).toContain('Case still violates the invariant');
    expect(first.stdout).toContain('Appended 1 case(s)');
    expect(first.status).toBe(1);
    expect(JSON.parse(fs.readFileSync(corpus, 'utf8'))).toEqual([
      {
        target: 'self-check-untyped-throw',
        input: 'promote me',
        note: expect.stringContaining('untyped-throw'),
      },
    ]);

    const second = runHarness(['--input-file', artifact, '--append-corpus'], env);
    expect(second.stdout).toContain('already contains every failing case');
    expect(JSON.parse(fs.readFileSync(corpus, 'utf8'))).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
