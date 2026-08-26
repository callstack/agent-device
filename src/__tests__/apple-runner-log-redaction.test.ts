import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const commitWaitPath = path.join(
  repoRoot,
  'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+SynthesizedCommitDeadline.swift',
);

// The synthesized bare-type commit wait polls the target field's live value on the shipped
// `type` path. That value is user content — a `type` command may carry credentials, tokens, or
// PII — and runner.log persists across the session. Cadence evidence must stay value-free.
//
// The enforcement is a typed Swift boundary (`logCommitCadence`), whose parameters are Ints
// only, so observed contents are unrepresentable at the call site; its emitted line is pinned
// by a sentinel-secret test in the host-lane policy tests. This guard is structural: it fails
// if the boundary disappears or if the poll path logs any other way. It deliberately does not
// parse Swift format strings — that review shape let raw values slip through interpolation.

const boundarySignature =
  /static func commitCadenceLogLine\(\s*elapsedMs: Int,\s*observedLen: Int,\s*expectedPrefixLen: Int\s*\) -> String/;
const loggingBoundarySignature =
  /static func logCommitCadence\(\s*elapsedMs: Int,\s*observedLen: Int,\s*expectedPrefixLen: Int\s*\)/;

function extractObserveClosure(source: string): string {
  const start = source.indexOf('observe: {');
  assert.ok(start !== -1, 'commit wait must inject an observe closure');
  const end = source.indexOf('waitForNextObservation:', start);
  assert.ok(end !== -1, 'commit wait must keep its waitForNextObservation seam');
  return source.slice(start, end);
}

test('commit-wait cadence logging goes through the typed value-free boundary', () => {
  const source = fs.readFileSync(commitWaitPath, 'utf8');

  assert.match(
    source,
    boundarySignature,
    'commitCadenceLogLine must accept only lengths/timestamps (Int parameters)',
  );
  assert.match(
    source,
    loggingBoundarySignature,
    'logCommitCadence is the only sanctioned logging entry for the poll path',
  );

  const observeClosure = extractObserveClosure(source);
  const directNSLogs = observeClosure.match(/NSLog\(/g) ?? [];
  assert.deepEqual(
    directNSLogs,
    [],
    'the poll path must log through logCommitCadence, never through a raw NSLog',
  );
  assert.match(
    observeClosure,
    /Self\.logCommitCadence\(/,
    'the poll path must emit its cadence evidence through the typed boundary',
  );

  // Cheap extra: no NSLog anywhere in the module interpolates the raw observed binding.
  for (
    let index = source.indexOf('NSLog(');
    index !== -1;
    index = source.indexOf('NSLog(', index + 1)
  ) {
    const window = source.slice(index, index + 400);
    assert.doesNotMatch(
      window,
      /NSLog\([^)]*\bobservedText\b/,
      'raw observedText must never reach NSLog',
    );
  }
});
