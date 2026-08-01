// The envelope is the only thing a downloaded scheduled-lane artifact can be
// interpreted from months later (#1430), so its required fields are asserted
// rather than assumed: a lane that stops emitting one of them makes freshness
// and tool-drift monitoring silently useless.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runCmdSync } from '../../src/utils/exec.ts';
import { laneEnvelope, LANE_ENVELOPE_SCHEMA_VERSION } from '../lib/lane-envelope.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

function workflow(name: string): string {
  return fs.readFileSync(path.join(repoRoot, '.github/workflows', name), 'utf8');
}

test('the envelope carries schema, commit, tool/config provenance, duration and result', () => {
  const envelope = laneEnvelope({
    lane: 'mutation-decision-kernels',
    commit: 'a'.repeat(40),
    tool: { stryker: '9.6.1' },
    configHash: 'sha256:abcdef123456',
    startedAtMs: 1_000,
    now: 61_000,
    result: 'pass',
    data: { scope: 'full-sweep' },
  });
  assert.equal(envelope.schemaVersion, LANE_ENVELOPE_SCHEMA_VERSION);
  assert.equal(envelope.lane, 'mutation-decision-kernels');
  assert.equal(envelope.commit, 'a'.repeat(40));
  assert.deepEqual(envelope.tool, { stryker: '9.6.1' });
  assert.equal(envelope.configHash, 'sha256:abcdef123456');
  // Mutation input is enumerated, not randomized: `null` is an explicit
  // "not applicable", not a forgotten field.
  assert.equal(envelope.seed, null);
  assert.equal(envelope.durationMs, 60_000);
  assert.equal(envelope.finishedAt, '1970-01-01T00:01:01.000Z');
  assert.equal(envelope.result, 'pass');
  assert.deepEqual(envelope.data, { scope: 'full-sweep' });
});

test('a failed ratchet is recorded as a failed lane run', () => {
  const envelope = laneEnvelope({
    lane: 'mutation-decision-kernels',
    commit: 'b'.repeat(40),
    tool: { stryker: '9.6.1' },
    configHash: 'sha256:abcdef123456',
    startedAtMs: 0,
    now: 0,
    result: 'fail',
    data: {},
  });
  assert.equal(envelope.result, 'fail');
  assert.equal(envelope.durationMs, 0);
});

// A lane that crashes before it can measure anything is the dark-lane case: an
// absent envelope is indistinguishable from a lane that never ran, so the run
// script must emit one from its failure path too.
test('a crashed run still writes an envelope naming the stage it died in', () => {
  const envelopePath = path.join(repoRoot, '.tmp/mutation/lane-envelope.json');
  fs.rmSync(envelopePath, { force: true });
  const result = runCmdSync(
    'node',
    [
      '--experimental-strip-types',
      'scripts/mutation/run.ts',
      '--report',
      '.tmp/mutation/absent-report.json',
      '--modules',
      'kernel-errors',
    ],
    { cwd: repoRoot, allowFailure: true },
  );
  assert.notEqual(result.exitCode, 0, 'a missing report must fail the run');
  assert.ok(fs.existsSync(envelopePath), 'no envelope written for a crashed run');
  const envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8')) as {
    result: string;
    tool: Record<string, string>;
    configHash: string;
    data: { stage: string; error: string | null };
  };
  assert.equal(envelope.result, 'fail');
  assert.equal(envelope.data.stage, 'report');
  assert.match(envelope.data.error ?? '', /absent-report\.json/);
  // Provenance is read before the work, so a crash still reports its tool/config.
  assert.ok(envelope.tool.stryker);
  assert.match(envelope.configHash, /^sha256:/);
});

// Shard artifacts carry the envelope next to the report, so merging "every JSON
// under the shard directory" fed the envelope to the report parser and crashed
// the ratchet job after the mutants had already run.
test('merging shard reports ignores the envelope sitting beside them', () => {
  const shards = path.join(repoRoot, '.tmp/mutation/envelope-test-shards/shard-a');
  fs.mkdirSync(shards, { recursive: true });
  fs.writeFileSync(
    path.join(shards, 'mutation.json'),
    JSON.stringify({
      files: {
        'packages/kernel/src/errors.ts': {
          mutants: [{ status: 'Killed' }, { status: 'Survived' }],
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(shards, 'lane-envelope.json'),
    JSON.stringify(
      laneEnvelope({
        lane: 'mutation-decision-kernels',
        commit: 'c'.repeat(40),
        tool: { stryker: '9.6.1' },
        configHash: 'sha256:abcdef123456',
        startedAtMs: 0,
        now: 0,
        result: 'pass',
        data: {},
      }),
    ),
  );
  const result = runCmdSync(
    'node',
    [
      '--experimental-strip-types',
      'scripts/mutation/run.ts',
      '--report-dir',
      '.tmp/mutation/envelope-test-shards',
      '--modules',
      'kernel-errors',
    ],
    { cwd: repoRoot, allowFailure: true },
  );
  assert.match(result.stdout, /merging 1 shard report\(s\)/);
  assert.match(result.stdout, /kernel-errors/);
  assert.doesNotMatch(result.stderr, /Cannot convert undefined or null to object/);
  fs.rmSync(path.join(repoRoot, '.tmp/mutation/envelope-test-shards'), {
    recursive: true,
    force: true,
  });
});

function runMutation(args: readonly string[]): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const result = runCmdSync(
    'node',
    ['--experimental-strip-types', 'scripts/mutation/run.ts', ...args],
    {
      cwd: repoRoot,
      allowFailure: true,
    },
  );
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
}

type Envelope = {
  result: string;
  data: { stage: string; error: string | null; modules: readonly { id: string }[] };
};

function readEnvelope(): Envelope {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, '.tmp/mutation/lane-envelope.json'), 'utf8'),
  ) as Envelope;
}

// A merged shard set is only a sweep if every requested module actually reported.
// summarizeReport scores an absent module as 0, and while the lane is non-gating a
// 0 only *reports* a regression — so a dead matrix shard would otherwise be
// aggregated into a passing "complete" envelope claiming the sweep happened.
test('an incomplete shard set fails instead of scoring the missing module as zero', () => {
  const shards = path.join(repoRoot, '.tmp/mutation/partial-shards/shard-kernel-errors');
  fs.mkdirSync(shards, { recursive: true });
  fs.writeFileSync(
    path.join(shards, 'mutation.json'),
    JSON.stringify({
      files: { 'packages/kernel/src/errors.ts': { mutants: [{ status: 'Killed' }] } },
    }),
  );
  const result = runMutation([
    '--report-dir',
    '.tmp/mutation/partial-shards',
    '--modules',
    'kernel-errors,daemon-ref-frame',
  ]);
  assert.notEqual(result.exitCode, 0, 'a missing shard must fail the aggregate');
  assert.match(result.stderr, /Incomplete shard set/);
  assert.match(result.stderr, /daemon-ref-frame/);
  const envelope = readEnvelope();
  assert.equal(envelope.result, 'fail');
  assert.equal(envelope.data.stage, 'ratchet');
  fs.rmSync(path.join(repoRoot, '.tmp/mutation/partial-shards'), { recursive: true, force: true });
});

// Argument parsing and the provenance/baseline reads used to sit outside the
// envelope boundary, so the lane could exit without declaring itself at all.
test('a malformed invocation still writes an envelope', () => {
  fs.rmSync(path.join(repoRoot, '.tmp/mutation/lane-envelope.json'), { force: true });
  const result = runMutation(['--modules', 'not-a-kernel']);
  assert.notEqual(result.exitCode, 0);
  const envelope = readEnvelope();
  assert.equal(envelope.result, 'fail');
  assert.equal(envelope.data.stage, 'setup');
  assert.match(envelope.data.error ?? '', /Unknown mutation module/);
});

// The weekly self-test and the affected-selection job run before any mutant, so
// their failure has to be declared by the lane rather than only by the job log.
test('--fail-envelope declares a step that failed before the sweep', () => {
  fs.rmSync(path.join(repoRoot, '.tmp/mutation/lane-envelope.json'), { force: true });
  const result = runMutation(['--fail-envelope', 'self-test failed']);
  assert.notEqual(result.exitCode, 0, 'a pre-run failure must not report success');
  const envelope = readEnvelope();
  assert.equal(envelope.result, 'fail');
  assert.equal(envelope.data.stage, 'setup');
  assert.equal(envelope.data.error, 'self-test failed');
});

// The workflows run it from `if: failure()`, which also fires when the ratchet
// itself failed — a generic reason must never displace the specific one.
test('--fail-envelope keeps a failure the run already reported', () => {
  fs.rmSync(path.join(repoRoot, '.tmp/mutation/lane-envelope.json'), { force: true });
  runMutation(['--fail-envelope', 'the real failure']);
  runMutation(['--fail-envelope', 'a later generic failure']);
  assert.equal(readEnvelope().data.error, 'the real failure');
});

// A pass is not a verdict worth preserving: the weekly job copies the proposed
// baseline and restores the committed one *after* the ratchet passed, so a failure
// there would otherwise publish the failed scheduled job as a passing lane.
test('--fail-envelope downgrades a passing envelope when a later step fails', () => {
  const shards = path.join(repoRoot, '.tmp/mutation/pass-then-fail/shard-kernel-errors');
  fs.mkdirSync(shards, { recursive: true });
  // A perfect shard so the ratchet passes: the score can only rise from the
  // committed kernel-errors baseline.
  fs.writeFileSync(
    path.join(shards, 'mutation.json'),
    JSON.stringify({
      files: {
        'packages/kernel/src/errors.ts': { mutants: [{ status: 'Killed' }, { status: 'Killed' }] },
      },
    }),
  );
  const passing = runMutation([
    '--report-dir',
    '.tmp/mutation/pass-then-fail',
    '--modules',
    'kernel-errors',
  ]);
  assert.equal(passing.exitCode, 0, passing.stderr);
  assert.equal(readEnvelope().result, 'pass');

  runMutation(['--fail-envelope', 'the baseline copy step failed']);
  const envelope = readEnvelope();
  assert.equal(envelope.result, 'fail', 'a failed job must not publish a passing envelope');
  assert.equal(envelope.data.error, 'the baseline copy step failed');
  fs.rmSync(path.join(repoRoot, '.tmp/mutation/pass-then-fail'), { recursive: true, force: true });
});

test('both mutation lanes record an envelope for failures before the sweep', () => {
  for (const name of ['mutation-weekly.yml', 'mutation-affected.yml']) {
    assert.match(workflow(name), /--fail-envelope/, `${name} can fail without an envelope`);
  }
});

test('both mutation lanes publish the envelope', () => {
  for (const name of ['mutation-weekly.yml', 'mutation-affected.yml']) {
    assert.match(
      workflow(name),
      /\.tmp\/mutation\/lane-envelope\.json/,
      `${name} does not upload the lane envelope`,
    );
  }
  assert.match(workflow('mutation-weekly.yml'), /Lane envelope/);
});
