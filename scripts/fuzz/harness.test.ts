// Tests of the fuzz harness itself (#1414).
//
// The corpus replay only proves clean inputs pass, so a regressed classifier or watchdog would
// leave every test green. These run the harness against the broken-on-purpose targets through
// the real CLI — same worker, watchdog, artifact, and promotion path a nightly failure takes —
// and require each failure kind to be reported.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LANE_ENVELOPE_SCHEMA_VERSION } from '../lib/lane-envelope.ts';
import { CASE_GENERATION_INPUTS } from './envelope.ts';
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

  // The two validation-only kinds (#1781 B2): without them a parser that silently accepts
  // invalid input, or rejects with the wrong code, would read as a pass forever.
  it('reports a silent acceptance of a case marked invalid as silent-accept', () => {
    const failure = checkCase(targetNamed('self-check-silent-accept'), 'case');
    expect(failure?.kind).toBe('silent-accept');
  });

  it('reports a rejection with an unexpected code as wrong-code', () => {
    const failure = checkCase(targetNamed('self-check-wrong-code'), 'case');
    expect(failure?.kind).toBe('wrong-code');
    expect(failure?.detail).toContain('expected INVALID_ARGS, got COMMAND_FAILED');
  });
});

describe('fuzz harness self-check', () => {
  // One run asserts both the report and its envelope: a second full self-check would cost five
  // more worker startups in the serialized subprocess-stub project (#1823) for no new signal.
  it('catches every seeded violation kind and writes the self-check envelope', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-selfcheck-'));
    const { status, stdout } = runHarness([
      '--self-check',
      '--case-timeout-ms',
      '750',
      '--artifact-dir',
      dir,
    ]);
    expect(stdout).toContain('ok   self-check-untyped-throw: expected untyped-throw');
    expect(stdout).toContain('ok   self-check-empty-hint: expected empty-hint');
    expect(stdout).toContain('ok   self-check-hang: expected hang, got hang');
    expect(stdout).toContain('ok   self-check-silent-accept: expected silent-accept');
    expect(stdout).toContain('ok   self-check-wrong-code: expected wrong-code');
    expect(status).toBe(0);
    const envelope = JSON.parse(fs.readFileSync(path.join(dir, 'run-envelope.json'), 'utf8'));
    expect(envelope.result).toBe('pass');
    expect(envelope.data.mode).toBe('self-check');
    expect(envelope.data.targetRuns).toHaveLength(5);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});

describe('worker startup budget', () => {
  // The watchdog used to start before the worker reported ready, so thread spawn plus type
  // stripping plus parser imports — hundreds of milliseconds — was charged to the first case and
  // reported as a hung parser. A budget far below real startup time is the regression: this only
  // passes because the budget starts at the worker's `ready` handshake.
  it('does not report a hang when startup outlasts the per-case budget', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-startup-'));
    const { stdout } = runHarness([
      '--target',
      'self-check-untyped-throw',
      '--iterations',
      '1',
      '--case-timeout-ms',
      '50',
      '--artifact-dir',
      dir,
    ]);
    expect(stdout).toContain('untyped-throw');
    expect(stdout).not.toContain('hang');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * Recomputes `configHash` over every case-generation input except `skip`. If the real hash equals
 * one of these, that file is not covered and a change to it would look like an unchanged lane.
 */
function hashWithout(skip: string): string {
  const digest = crypto.createHash('sha256');
  for (const name of CASE_GENERATION_INPUTS) {
    if (name !== skip) digest.update(fs.readFileSync(path.join(FUZZ_DIR, name)));
  }
  return `sha256:${digest.digest('hex').slice(0, 16)}`;
}

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
    // The shape is #1430's shared contract, not this lane's invention.
    expect(envelope.schemaVersion).toBe(LANE_ENVELOPE_SCHEMA_VERSION);
    // Drift provenance: fast-check's version and the case-generation sources both decide what a
    // seed produces, so an upgrade or a generator edit must be visible without reading logs.
    expect(envelope.tool['fast-check']).toMatch(/^\d+\.\d+\.\d+/);
    expect(envelope.configHash).toMatch(/^sha256:/);
    expect(envelope.configHash).not.toBe(hashWithout('generate.ts'));
    expect(envelope.result).toBe('pass');
    expect(envelope.data.mode).toBe('generate');
    expect(envelope.data.targetRuns[0].target).toBe('selector');
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
    expect(envelope.data.failures[0].kind).toBe('untyped-throw');
    expect(envelope.data.reproCommands[0]).toContain('--input-file');
  });

  // A malformed workflow-dispatch input used to throw out of option parsing before anything
  // could write an envelope, which reads to monitoring exactly like a lane that went dark.
  it('is written when the options themselves are malformed', () => {
    const { envelope, status } = envelopeFrom(['--iterations', 'lots']);
    expect(status).toBe(1);
    expect(envelope.result).toBe('fail');
    expect(envelope.data.stage).toBe('error');
    expect(envelope.data.targetRuns).toEqual([]);
  });

  it('is written for an unknown flag', () => {
    const { envelope, status } = envelopeFrom(['--not-a-flag']);
    expect(status).toBe(1);
    expect(envelope.result).toBe('fail');
    expect(envelope.data.stage).toBe('error');
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
