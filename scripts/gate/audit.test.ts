// Structural ownership regressions: only the canonical action can declare a gate.

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CHECK_CATALOG } from '../check-affected/checks.ts';
import { audit, formatFailures } from './audit.ts';
import { MANUAL_ONLY_OWNERS } from './declarations.ts';
import { covered, loadModel, type Model } from './model.ts';
import { loadLanes } from './workflows.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const base = loadModel(repoRoot, tracked);

function plant(yaml: string): Model {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-lane-'));
  try {
    fs.writeFileSync(path.join(dir, 'planted.yml'), yaml);
    return { ...base, lanes: [...base.lanes, ...loadLanes(dir, repoRoot, base.scripts)] };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const workflow = (step: string) => `name: Planted
on:
  pull_request:
jobs:
  planted:
    steps:
${step}`;

test('the live tree is green', () => {
  assert.deepEqual(audit(base), []);
});

test('a structural gate id must exist in CHECK_CATALOG', () => {
  const model = plant(
    workflow(`      - uses: ./.github/actions/run-gate
        with:
          gate: not-a-real-check`),
  );
  assert.ok(audit(model).some((failure) => /names no registered check/.test(failure.message)));
});

test('raw shell text cannot declare ownership', () => {
  const model = plant(
    workflow(`      - run: |
          pnpm gate not-a-real-check
          echo "pnpm gate layering"`),
  );
  assert.ok(!audit(model).some((failure) => /not-a-real-check/.test(failure.message)));
});

test('reusable workflows fail closed because their action declarations are hidden', () => {
  const model = plant(`name: Planted
on:
  pull_request:
jobs:
  planted:
    uses: ./.github/workflows/reusable.yml`);
  assert.ok(
    audit(model).some((failure) => /runs steps this loader never opens/.test(failure.message)),
  );
});

// The exemption is what keeps the tree green while these lanes are parked, so nothing else
// would notice it going stale: a re-scheduled lane would silently keep its "nothing runs this"
// declaration, and the next parked check would be waved through under a name that no longer
// describes it.
test('every manual-only declaration names a registered check no qualifying lane owns', () => {
  for (const id of Object.keys(MANUAL_ONLY_OWNERS)) {
    const spec = CHECK_CATALOG.find((entry) => entry.id === id);
    assert.ok(spec, `manual-only declaration "${id}" names no registered check`);
    assert.equal(
      covered(spec, null, base).covered,
      false,
      `"${id}" is owned by a pull_request/schedule lane again — drop its MANUAL_ONLY_OWNERS entry`,
    );
  }
});

/** The live model with the parked dispatch lanes rewritten, to age the declaration on purpose. */
function withManualLanes(rewrite: (lane: Model['lanes'][number]) => Model['lanes'][number] | null) {
  const parked = new Set(Object.values(MANUAL_ONLY_OWNERS).map((owner) => owner.lane));
  return {
    ...base,
    lanes: base.lanes.flatMap((lane) => {
      if (!parked.has(lane.label)) return [lane];
      const rewritten = rewrite(lane);
      return rewritten ? [rewritten] : [];
    }),
  };
}

test('deleting a manual-only declaration reports its check as unowned', () => {
  const failures = audit(base, { manualOnly: {}, unprovable: {} });
  for (const id of Object.keys(MANUAL_ONLY_OWNERS)) {
    assert.ok(
      failures.some(
        (failure) => failure.assertion === 'owned' && failure.message.includes(`"${id}"`),
      ),
      `dropping the declaration for "${id}" must surface it as unowned, not as wired`,
    );
  }
});

// The failure this record exists to prevent: parked coverage quietly becoming deleted coverage.
test('deleting a parked job fails instead of reading as still parked', () => {
  const failures = audit(withManualLanes(() => null));
  for (const id of Object.keys(MANUAL_ONLY_OWNERS)) {
    assert.ok(
      failures.some(
        (failure) =>
          failure.assertion === 'manual-only' &&
          failure.message.includes(`"${id}"`) &&
          failure.message.includes('no workflow defines'),
      ),
      `deleting the lane "${MANUAL_ONLY_OWNERS[id]?.lane}" must fail the manifest for "${id}"`,
    );
  }
});

// `qualifying` alone cannot carry this: swapping `workflow_dispatch` for `push` keeps the lane
// non-qualifying, so without the trigger kinds the audit would stay green while the run nobody
// starts by hand became a run nobody starts by hand *or* reviews.
test('a parked lane re-triggered by push fails even though push does not qualify', () => {
  const failures = audit(
    withManualLanes((lane) => ({ ...lane, qualifying: false, triggers: ['push'] })),
  );
  assert.ok(
    failures.some(
      (failure) =>
        failure.assertion === 'manual-only' && failure.message.includes('is triggered by push'),
    ),
    'replacing workflow_dispatch with another non-qualifying trigger must fail',
  );
});

test('a parked lane that loses workflow_dispatch entirely fails', () => {
  const failures = audit(withManualLanes((lane) => ({ ...lane, triggers: [] })));
  assert.ok(
    failures.some(
      (failure) =>
        failure.assertion === 'manual-only' && failure.message.includes('no trigger at all'),
    ),
  );
});

test('a parked lane back on a schedule fails until its declaration is deleted', () => {
  const failures = audit(withManualLanes((lane) => ({ ...lane, qualifying: true })));
  assert.ok(
    failures.some(
      (failure) =>
        failure.assertion === 'manual-only' &&
        /runs on pull_request\/schedule again/.test(failure.message),
    ),
  );
});

// Android is the reason `opaque` exists: its gate sits inside a third-party action's `script:`,
// so the lane's own steps can never show it and the job's existence is the whole attestation.
test('a parked lane that stops declaring its gate fails unless the gate is opaque', () => {
  const failures = audit(withManualLanes((lane) => ({ ...lane, gates: [] })));
  assert.ok(
    failures.some(
      (failure) =>
        failure.assertion === 'manual-only' && failure.message.includes('no longer declares gate'),
    ),
    'a visible parked lane losing its run-gate step must fail',
  );
  assert.ok(
    !failures.some((failure) => failure.message.includes('gate "replay-android"')),
    'the opaque Android entry cannot assert a step the loader never reads',
  );
});

test('unknown assertion kinds remain visible in the report', () => {
  const report = formatFailures([
    { assertion: 'owned', message: 'a' },
    { assertion: 'new-kind', message: 'b' },
  ]);
  assert.match(report, /Registered checks no lane declares:/);
  assert.match(report, /Other failures \(new-kind\):/);
  assert.match(report, /2 failure\(s\)/);
});
