// Deterministic conformance gate. Runs in normal CI via `node --test` (no Java),
// the same pattern as the layering-guard job. It replays the checked-in,
// JVM-generated fixtures against the live agent-device engine.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  type FlowResult,
  checkCoverage,
  checkFixtureSeals,
  checkLayer2,
  classifyAllFlows,
  loadLayer1,
  loadLayer2,
} from './verify.ts';
import {
  DOCUMENTED_DEVIATIONS,
  FLOW_DIVERGENCES,
  LAYER2_REFERENCE_ONLY,
} from './expected-divergence.ts';
// @ts-expect-error -- .mjs helper shared with regenerate.mjs; no type declarations.
import { checkFixtureSeal } from './fixture-seal.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PIN = JSON.parse(fs.readFileSync(path.join(HERE, 'pinned-upstream.json'), 'utf8'));

function flowsById(): Map<string, FlowResult> {
  return new Map(classifyAllFlows().map((flow) => [flow.id, flow]));
}

test('fixture content is sealed against hand editing', () => {
  for (const result of checkFixtureSeals()) {
    assert.ok(result.actual, `${result.file} has no contentHash — regenerate it`);
    assert.equal(
      result.actual,
      result.expected,
      `${result.file} content does not match its seal. Fixtures are generated: run \`pnpm maestro:conformance:regenerate\` rather than editing them by hand.`,
    );
  }
});

// The seal is only worth having if it actually catches an edit. Prove it does,
// rather than trusting that a hash comparison must work.
test('the seal rejects an edited capture (proof the check has teeth)', () => {
  const original = JSON.parse(
    fs.readFileSync(path.join(HERE, 'fixtures', 'layer2-semantics.json'), 'utf8'),
  );
  // Forge the retry cap the way a hand-transcribed fixture would have drifted.
  const tampered = structuredClone(original);
  const retryCap = tampered.constants.find((c: { id: string }) => c.id === 'retryMaxRetries');
  retryCap.value = 99;
  const { expected, actual } = checkFixtureSeal(tampered);
  assert.notEqual(expected, actual, 'editing a captured constant must break the seal');
  // ...and the untouched fixture still verifies, so the check is not just always-fail.
  const clean = checkFixtureSeal(original);
  assert.equal(clean.expected, clean.actual);
});

test('fixtures pin the reviewed upstream Maestro artifacts', () => {
  for (const fixture of [loadLayer1(), loadLayer2()] as Array<{ upstream?: unknown }>) {
    const upstream = (fixture as { upstream: { version: string; commit: string; artifacts: unknown } })
      .upstream;
    assert.equal(upstream.version, PIN.version, 'fixture must pin the reviewed version');
    assert.equal(upstream.commit, PIN.commit, 'fixture must pin the reviewed commit');
    assert.deepEqual(upstream.artifacts, PIN.artifacts, 'fixture jar SHAs must match pinned-upstream.json');
  }
});

test('layer 1: our engine never accepts a flow upstream rejects', () => {
  const lenient = classifyAllFlows().filter((flow) => flow.classification === 'we-are-lenient');
  assert.deepEqual(
    lenient.map((flow) => flow.id),
    [],
    'agent-device parsed a flow that upstream Maestro rejects — a conformance regression',
  );
});

test('layer 1: every divergence is declared (no silent drift)', () => {
  const flows = classifyAllFlows();
  const problems: string[] = [];
  for (const flow of flows) {
    const declared = FLOW_DIVERGENCES[flow.id];
    if (flow.classification === 'identical' || flow.classification === 'both-reject') {
      if (declared) problems.push(`${flow.id}: declared divergence but classified ${flow.classification}`);
      continue;
    }
    if (!declared) {
      problems.push(`${flow.id}: undeclared ${flow.classification}${flow.detail ? `\n    ${flow.detail}` : ''}`);
      continue;
    }
    if (declared.classification !== flow.classification) {
      problems.push(`${flow.id}: declared ${declared.classification} but classified ${flow.classification}`);
    }
    if (flow.classification === 'we-reject' && !(declared.unsupported && declared.unsupported.length > 0)) {
      problems.push(`${flow.id}: we-reject entries must list the unsupported command(s)/option(s)`);
    }
  }
  assert.deepEqual(problems, [], `Undeclared or mismatched divergences:\n  ${problems.join('\n  ')}`);
});

test('layer 1: no stale divergence declarations', () => {
  const ids = new Set(classifyAllFlows().map((flow) => flow.id));
  const stale = Object.keys(FLOW_DIVERGENCES).filter((id) => !ids.has(id));
  assert.deepEqual(stale, [], 'FLOW_DIVERGENCES references flows no longer in the corpus');
});

test('layer 2: generated semantic vectors match live engine constants', () => {
  const results = checkLayer2();
  const mismatched = results.filter((result) => result.status === 'mismatch');
  assert.deepEqual(
    mismatched.map((result) => `${result.id}: upstream=${result.upstream} agent=${result.agent}`),
    [],
    'a layer-2 semantic vector drifted from its agent-device constant',
  );
  // Every reference-only vector must be an on-the-record deviation.
  for (const result of results) {
    if (result.status === 'reference-only') {
      const documented = DOCUMENTED_DEVIATIONS.some((d) => d.description.includes(result.id) || LAYER2_REFERENCE_ONLY.has(result.id));
      assert.ok(documented, `reference-only vector ${result.id} must be a documented deviation`);
    }
  }
});

test('coverage: every supported command is fixture-backed or explicitly unverified', () => {
  const gaps = checkCoverage().filter((result) => !result.covered && !result.unverified);
  assert.deepEqual(
    gaps.map((result) => result.command),
    [],
    'supported commands with no corpus coverage — add a flow or list them in UNVERIFIED_COMMANDS',
  );
});

// --- The four #1217 bug classes, each tied to its fixture ---

test('bug class 1: decimal percentage coordinates are rejected (not rounded)', () => {
  const flow = flowsById().get('bug-classes/percent-decimal-swipe');
  assert.equal(flow?.upstreamStatus, 'rejected', 'upstream rejects "50.5%, 50%"');
  assert.equal(flow?.classification, 'both-reject', 'agent-device must also reject decimals');
});

test('bug class 2: a target swipe without a direction is rejected', () => {
  const flow = flowsById().get('bug-classes/target-swipe-missing-direction');
  assert.equal(flow?.upstreamStatus, 'rejected', 'upstream requires an explicit direction');
  assert.equal(flow?.classification, 'both-reject', 'agent-device must also reject it');
});

test('bug class 3: the retry cap matches the upstream MAX_RETRIES_ALLOWED constant', () => {
  const retryCap = checkLayer2().find((result) => result.id === 'retryMaxRetries');
  assert.equal(retryCap?.status, 'match');
  assert.equal(retryCap?.upstream, 3, 'upstream clamps retry blocks to 3');
  // Parse parity: an over-cap maxRetries is stored verbatim (the clamp is runtime).
  assert.equal(flowsById().get('bug-classes/retry-over-cap')?.classification, 'identical');
});

test('bug class 4: settle default parses identically; ordering is a layer-3 differential', () => {
  assert.equal(flowsById().get('bug-classes/settle-after-tap')?.classification, 'identical');
  // The 200ms x 10 settle loop has no reflectable upstream constant; the
  // sleep-after-capture ordering is verified by the layer-3 differential scenario.
  const layer2 = loadLayer2();
  assert.ok(
    !layer2.constants.some((constant) => /settle/i.test(constant.id) && constant.id !== 'iosScreenSettleTimeoutMs'),
    'no upstream settle-loop constant exists to cross-check; keep this as layer 3',
  );
});
