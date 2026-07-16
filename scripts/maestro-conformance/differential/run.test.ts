// Device-free self-test for the layer-3 differential registry. Runs in unit CI
// via node --test; the live device comparison itself runs only on the scheduled
// conformance-differential workflow.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DIFFERENTIAL_APP_ID, DIFFERENTIAL_SCENARIOS } from './scenarios.ts';
import { parseRunnerArgs, selectScenarios, validateScenarios } from './run.ts';

const CONFORMANCE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every differential scenario references an existing corpus flow with a unique id', () => {
  assert.doesNotThrow(() => validateScenarios());
  assert.ok(DIFFERENTIAL_SCENARIOS.length > 0, 'expected at least one differential scenario');
});

test('the settle-loop bug class (4) is covered by a differential scenario', () => {
  const settle = DIFFERENTIAL_SCENARIOS.find((scenario) => scenario.bugClass === 4);
  assert.ok(settle, 'bug class 4 (settle ordering) has no reflectable constant; it must be a differential scenario');
  assert.equal(settle?.id, 'settle-after-tap');
});

test('--trace-root is accepted so engine-side invariants can be evaluated', () => {
  const options = parseRunnerArgs(['--trace-root', '/tmp/artifacts']);
  assert.equal(options.traceRoot, '/tmp/artifacts');
});

// The layer-1 corpus exists to be PARSED: its flows name a fictional
// com.example.app and elements that exist on no device. Pointing a device
// scenario at one produces a run that fails before it exercises any runtime
// behavior — which is exactly how the settle detector was silently vacuous.
test('no differential scenario points at the parse-only layer-1 corpus', () => {
  const corpusBacked = DIFFERENTIAL_SCENARIOS.filter((s) => s.flow.startsWith('corpus/'));
  assert.deepEqual(
    corpusBacked.map((s) => s.id),
    [],
    'device scenarios must use differential/flows (real fixture app), not the parse corpus',
  );
  for (const scenario of DIFFERENTIAL_SCENARIOS) {
    assert.ok(
      scenario.flow.startsWith('differential/flows/'),
      `${scenario.id}: expected a device flow under differential/flows`,
    );
  }
});

// A declared divergence without an issue behind it is how "temporarily expected"
// becomes permanent without anyone deciding to. Layer 1 requires `unsupported`
// on every we-reject entry for the same reason; enforce the twin here, because
// the lesson of this whole arc is that prose discipline does not survive contact
// with a two-day debugging session.
test('every knownDivergence carries a tracking issue', () => {
  const problems: string[] = [];
  for (const scenario of DIFFERENTIAL_SCENARIOS) {
    const declared = scenario.knownDivergence;
    if (!declared) continue;
    if (!/^https:\/\/github\.com\/.+\/issues\/\d+$/.test(declared.tracking ?? '')) {
      problems.push(`${scenario.id}: knownDivergence.tracking must be a GitHub issue URL`);
    }
    if (!declared.reason || declared.reason.length < 20) {
      problems.push(`${scenario.id}: knownDivergence.reason must explain what it blocks`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('every device flow targets the fixture app the workflow installs', () => {
  for (const scenario of DIFFERENTIAL_SCENARIOS) {
    const body = fs.readFileSync(path.join(CONFORMANCE_DIR, scenario.flow), 'utf8');
    assert.match(
      body,
      new RegExp(`^appId:\\s*${DIFFERENTIAL_APP_ID}$`, 'm'),
      `${scenario.id} must target ${DIFFERENTIAL_APP_ID}; a flow against any other app cannot run on the CI simulator`,
    );
  }
});

test('--only selects a single scenario and rejects unknown ids', () => {
  assert.equal(selectScenarios('settle-after-tap').length, 1);
  assert.throws(() => selectScenarios('does-not-exist'), /No scenario named/);
});

test('runner arg parsing honors dry-run and platform', () => {
  const options = parseRunnerArgs(['--dry-run', '--platform', 'ios']);
  assert.equal(options.dryRun, true);
  assert.equal(options.platform, 'ios');
});
