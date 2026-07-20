import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createToolRefPinStore } from '../tool-ref-pins.ts';

function makeStore() {
  return createToolRefPinStore();
}

test('ref-pin store keeps per-ref provenance across snapshot and find captures', () => {
  const pins = makeStore();

  pins.mergeCommandResult(
    'snapshot',
    { nodes: [{ ref: 'e2' }, { ref: 'e37' }], truncated: false, refsGeneration: 500012 },
    undefined,
    'demo',
  );
  pins.mergeCommandResult('find', { ref: '@e5', refsGeneration: 500013 }, undefined, 'demo');

  const pinned = pins.pinInput(
    'press',
    { session: 'demo', target: { kind: 'ref', ref: '@e37' } },
    undefined,
  );
  assert.deepEqual(pinned, {
    session: 'demo',
    target: { kind: 'ref', ref: '@e37~s500012' },
  });
});

test('ref-pin store pins the find-issued ref to the find generation', () => {
  const pins = makeStore();

  pins.mergeCommandResult(
    'snapshot',
    { nodes: [{ ref: 'e2' }, { ref: 'e37' }], truncated: false, refsGeneration: 500012 },
    undefined,
    'demo',
  );
  pins.mergeCommandResult('find', { ref: '@e5', refsGeneration: 500013 }, undefined, 'demo');

  const pinned = pins.pinInput(
    'press',
    { session: 'demo', target: { kind: 'ref', ref: '@e5' } },
    undefined,
  );
  assert.deepEqual(pinned, {
    session: 'demo',
    target: { kind: 'ref', ref: '@e5~s500013' },
  });
});

test('ref-pin store pins wait refs and get targets from the per-ref map', () => {
  const pins = makeStore();

  pins.mergeCommandResult(
    'snapshot',
    { nodes: [{ ref: 'e2' }, { ref: 'e37' }], truncated: false, refsGeneration: 500012 },
    undefined,
    'demo',
  );

  const wait = pins.pinInput('wait', { session: 'demo', ref: '@e2' }, undefined);
  const get = pins.pinInput(
    'get',
    { session: 'demo', format: 'text', target: { kind: 'ref', ref: '@e37' } },
    undefined,
  );

  assert.deepEqual(wait, { session: 'demo', ref: '@e2~s500012' });
  assert.deepEqual(get, {
    session: 'demo',
    format: 'text',
    target: { kind: 'ref', ref: '@e37~s500012' },
  });
});

test('ref-pin store merges digest-level snapshot refs too', () => {
  const pins = makeStore();

  pins.mergeCommandResult(
    'snapshot',
    { nodeCount: 1, refs: [{ ref: 'e9', label: 'Continue' }], refsGeneration: 41 },
    undefined,
    'demo',
  );

  const pinned = pins.pinInput(
    'press',
    { session: 'demo', target: { kind: 'ref', ref: '@e9' } },
    undefined,
  );
  assert.deepEqual(pinned, { session: 'demo', target: { kind: 'ref', ref: '@e9~s41' } });
});

// --- #1101 --settle: interaction responses re-pin from the settled diff ---

test('ref-pin store merges per-ref pins from a settle response diff', () => {
  const pins = makeStore();

  pins.mergeCommandResult(
    'snapshot',
    { nodes: [{ ref: 'e2' }, { ref: 'e37' }], truncated: false, refsGeneration: 7 },
    undefined,
    'demo',
  );
  pins.mergeCommandResult(
    'press',
    {
      ref: 'e2',
      settle: {
        settled: true,
        waitedMs: 60,
        captures: 2,
        quietMs: 25,
        timeoutMs: 2000,
        refsGeneration: 8,
        diff: {
          summary: { additions: 1, removals: 1, unchanged: 1 },
          lines: [
            { kind: 'removed', text: '@e2 [button] "Continue"' },
            { kind: 'added', text: '@e4 [text] "Welcome!"', ref: 'e4' },
          ],
        },
      },
    },
    undefined,
    'demo',
  );

  const first = pins.pinInput(
    'press',
    { session: 'demo', target: { kind: 'ref', ref: '@e2' } },
    undefined,
  );
  const second = pins.pinInput(
    'press',
    { session: 'demo', target: { kind: 'ref', ref: '@e4' } },
    undefined,
  );
  const untouched = pins.pinInput(
    'get',
    { session: 'demo', format: 'text', target: { kind: 'ref', ref: '@e37' } },
    undefined,
  );

  assert.deepEqual(first, { session: 'demo', target: { kind: 'ref', ref: '@e2~s7' } });
  assert.deepEqual(second, { session: 'demo', target: { kind: 'ref', ref: '@e4~s8' } });
  assert.deepEqual(untouched, {
    session: 'demo',
    format: 'text',
    target: { kind: 'ref', ref: '@e37~s7' },
  });
});

test('ref-pin store merges digest-level settled refs too', () => {
  const pins = makeStore();

  pins.mergeCommandResult(
    'press',
    {
      ref: 'e2',
      settle: {
        settled: true,
        waitedMs: 2000,
        captures: 7,
        quietMs: 25,
        timeoutMs: 2000,
        refsGeneration: 9,
        refs: [{ ref: 'e4' }],
        diff: {
          summary: { additions: 1, removals: 1, unchanged: 1 },
        },
      },
    },
    undefined,
    'demo',
  );

  const pinned = pins.pinInput(
    'press',
    { session: 'demo', target: { kind: 'ref', ref: '@e4' } },
    undefined,
  );
  assert.deepEqual(pinned, { session: 'demo', target: { kind: 'ref', ref: '@e4~s9' } });
});

test('ref-pin store merges per-ref pins from a settle response unchanged-interactive tail', () => {
  const pins = makeStore();

  pins.mergeCommandResult(
    'press',
    {
      ref: 'e2',
      settle: {
        settled: true,
        waitedMs: 60,
        captures: 2,
        quietMs: 25,
        timeoutMs: 2000,
        refsGeneration: 9,
        diff: {
          summary: { additions: 0, removals: 1, unchanged: 1 },
          lines: [{ kind: 'removed', text: '@e2 [button] "OK"' }],
        },
        tail: [{ ref: 'e1', role: 'button', label: 'Continue' }],
      },
    },
    undefined,
    'demo',
  );

  const pinned = pins.pinInput(
    'press',
    { session: 'demo', target: { kind: 'ref', ref: '@e1' } },
    undefined,
  );
  assert.deepEqual(pinned, { session: 'demo', target: { kind: 'ref', ref: '@e1~s9' } });
});

test('ref-pin store leaves pins untouched for plain interaction responses', () => {
  const pins = makeStore();

  pins.mergeCommandResult(
    'snapshot',
    { nodes: [{ ref: 'e2' }], truncated: false, refsGeneration: 7 },
    undefined,
    'demo',
  );
  pins.mergeCommandResult('press', { ref: 'e2', x: 10, y: 20 }, undefined, 'demo');

  const first = pins.pinInput(
    'press',
    { session: 'demo', target: { kind: 'ref', ref: '@e2' } },
    undefined,
  );
  const second = pins.pinInput(
    'press',
    { session: 'demo', target: { kind: 'ref', ref: '@e2' } },
    undefined,
  );

  assert.deepEqual(first, { session: 'demo', target: { kind: 'ref', ref: '@e2~s7' } });
  assert.deepEqual(second, { session: 'demo', target: { kind: 'ref', ref: '@e2~s7' } });
});

// --- ADR 0012 decision 2: resolution diagnostics are never ref-issued/pinned ---

test('ref-pin store never pins resolution.winnerDiagnostic/alternatives', () => {
  const pins = makeStore();

  pins.mergeCommandResult(
    'snapshot',
    { nodes: [{ ref: 'e2' }, { ref: 'e3' }], truncated: false, refsGeneration: 7 },
    undefined,
    'demo',
  );
  pins.mergeCommandResult(
    'press',
    {
      ref: 'e2',
      resolution: {
        source: 'runtime',
        phase: 'pre-action',
        kind: 'disambiguated',
        matchCount: 2,
        winnerDiagnostic: { diagnosticRef: 'diag-e2', role: 'button', label: 'Profile' },
        tiebreak: 'visible',
        alternatives: [{ diagnosticRef: 'diag-e3', role: 'button', label: 'Profile' }],
      },
    },
    undefined,
    'demo',
  );

  const e2 = pins.pinInput(
    'press',
    { session: 'demo', target: { kind: 'ref', ref: '@e2' } },
    undefined,
  );
  const e3 = pins.pinInput(
    'press',
    { session: 'demo', target: { kind: 'ref', ref: '@e3' } },
    undefined,
  );
  const diag = pins.pinInput(
    'press',
    { session: 'demo', target: { kind: 'ref', ref: '@diag-e3' } },
    undefined,
  );

  assert.deepEqual(e2, { session: 'demo', target: { kind: 'ref', ref: '@e2~s7' } });
  assert.deepEqual(e3, { session: 'demo', target: { kind: 'ref', ref: '@e3~s7' } });
  assert.deepEqual(diag, { session: 'demo', target: { kind: 'ref', ref: '@diag-e3' } });
});

test('ref-pin store passes never-issued refs through unpinned', () => {
  const pins = makeStore();

  pins.mergeCommandResult(
    'snapshot',
    { nodes: [{ ref: 'e2' }, { ref: 'e37' }], truncated: false, refsGeneration: 500012 },
    undefined,
    'demo',
  );

  const pinned = pins.pinInput(
    'press',
    { session: 'demo', target: { kind: 'ref', ref: '@e99' } },
    undefined,
  );
  assert.deepEqual(pinned, { session: 'demo', target: { kind: 'ref', ref: '@e99' } });
});

test('ref-pin store passes refs through unpinned when the scope has no history', () => {
  const pins = makeStore();

  pins.mergeCommandResult(
    'snapshot',
    { nodes: [{ ref: 'e2' }], truncated: false, refsGeneration: 500012 },
    undefined,
    'other',
  );

  const pinned = pins.pinInput(
    'press',
    { session: 'demo', target: { kind: 'ref', ref: '@e2' } },
    undefined,
  );
  assert.deepEqual(pinned, { session: 'demo', target: { kind: 'ref', ref: '@e2' } });
});

test('ref-pin store scopes by state dir so same-named sessions never cross-pollinate', () => {
  const pins = makeStore();

  pins.mergeCommandResult(
    'snapshot',
    { nodes: [{ ref: 'e2' }], truncated: false, refsGeneration: 500012 },
    '/state/a',
    'demo',
  );

  const otherState = pins.pinInput(
    'press',
    { session: 'demo', stateDir: '/state/b', target: { kind: 'ref', ref: '@e2' } },
    '/state/b',
  );
  const originalState = pins.pinInput(
    'press',
    { session: 'demo', stateDir: '/state/a', target: { kind: 'ref', ref: '@e2' } },
    '/state/a',
  );

  assert.deepEqual(otherState, {
    session: 'demo',
    stateDir: '/state/b',
    target: { kind: 'ref', ref: '@e2' },
  });
  assert.deepEqual(originalState, {
    session: 'demo',
    stateDir: '/state/a',
    target: { kind: 'ref', ref: '@e2~s500012' },
  });
});

test('ref-pin store clears the whole scope when a ref-issuing response stops carrying a generation', () => {
  const pins = makeStore();

  pins.mergeCommandResult(
    'snapshot',
    { nodes: [{ ref: 'e2' }], truncated: false, refsGeneration: 4 },
    undefined,
    'demo',
  );
  pins.mergeCommandResult(
    'snapshot',
    { nodes: [{ ref: 'e2' }], truncated: false },
    undefined,
    'demo',
  );

  const pinned = pins.pinInput(
    'press',
    { session: 'demo', target: { kind: 'ref', ref: '@e2' } },
    undefined,
  );
  assert.deepEqual(pinned, { session: 'demo', target: { kind: 'ref', ref: '@e2' } });
});

test('ref-pin store never rewrites refs that already carry a suffix and never pins non-@ refs', () => {
  const pins = makeStore();

  pins.mergeCommandResult(
    'snapshot',
    { nodes: [{ ref: 'e2' }], truncated: false, refsGeneration: 500012 },
    undefined,
    'demo',
  );

  const alreadyPinned = pins.pinInput(
    'press',
    { session: 'demo', target: { kind: 'ref', ref: '@e2~s3' } },
    undefined,
  );
  const missingAt = pins.pinInput(
    'press',
    { session: 'demo', target: { kind: 'ref', ref: 'e2' } },
    undefined,
  );

  assert.deepEqual(alreadyPinned, { session: 'demo', target: { kind: 'ref', ref: '@e2~s3' } });
  assert.deepEqual(missingAt, { session: 'demo', target: { kind: 'ref', ref: 'e2' } });
});

test('ref-pin store bounds retained pins per scope', () => {
  const pins = makeStore();

  const nodes = [];
  for (let i = 0; i < 1002; i++) {
    nodes.push({ ref: `e${i}` });
  }
  pins.mergeCommandResult('snapshot', { nodes, refsGeneration: 1 }, undefined, 'demo');

  const first = pins.pinInput(
    'press',
    { session: 'demo', target: { kind: 'ref', ref: '@e0' } },
    undefined,
  );
  const last = pins.pinInput(
    'press',
    { session: 'demo', target: { kind: 'ref', ref: '@e1001' } },
    undefined,
  );

  assert.deepEqual(first, { session: 'demo', target: { kind: 'ref', ref: '@e0' } });
  assert.deepEqual(last, { session: 'demo', target: { kind: 'ref', ref: '@e1001~s1' } });
});

// --- ADR 0012 migration step 2: replay divergence is a ref-issuing error ---

function replayDivergenceDetails(): Record<string, unknown> {
  return {
    step: 2,
    action: 'click',
    divergence: {
      version: 1,
      kind: 'action-failure',
      step: { index: 2, source: { path: '/tmp/flow.ad', line: 2 } },
      action: 'click "Save"',
      cause: { code: 'COMMAND_FAILED', message: 'not hittable' },
      screen: {
        state: 'available',
        refsGeneration: 12,
        refs: [{ ref: 'e5', role: 'button', label: 'Save' }],
      },
      suggestions: [
        { selector: 'id="save"', basis: 'id', ref: 'e5', role: 'button', label: 'Save' },
      ],
      suggestionCount: 1,
      resume: { allowed: false, reason: 'resume not yet supported' },
      repairHint: 'record-and-heal',
    },
  };
}

test('ref-pin store merges divergence screen refs and pins them for later inputs', () => {
  const pins = makeStore();

  pins.mergeDivergenceScreen(replayDivergenceDetails(), undefined, 'demo');

  const pinned = pins.pinInput(
    'press',
    { session: 'demo', target: { kind: 'ref', ref: '@e5' } },
    undefined,
  );
  assert.deepEqual(pinned, { session: 'demo', target: { kind: 'ref', ref: '@e5~s12' } });
});

test('ref-pin store leaves existing pins untouched for an error without a divergence', () => {
  const pins = makeStore();

  pins.mergeCommandResult(
    'snapshot',
    { nodes: [{ ref: 'e2' }], truncated: false, refsGeneration: 7 },
    undefined,
    'demo',
  );
  pins.mergeDivergenceScreen({ code: 'INVALID_ARGS', message: 'bad selector' }, undefined, 'demo');

  const pinned = pins.pinInput(
    'press',
    { session: 'demo', target: { kind: 'ref', ref: '@e2' } },
    undefined,
  );
  assert.deepEqual(pinned, { session: 'demo', target: { kind: 'ref', ref: '@e2~s7' } });
});

test('ref-pin store leaves existing pins untouched for a mutating find without refsGeneration', () => {
  const pins = makeStore();

  pins.mergeCommandResult(
    'snapshot',
    { nodes: [{ ref: 'e2' }], truncated: false, refsGeneration: 7 },
    undefined,
    'demo',
  );
  pins.mergeCommandResult('find', { ref: '@e2' }, undefined, 'demo');

  const pinned = pins.pinInput(
    'press',
    { session: 'demo', target: { kind: 'ref', ref: '@e2' } },
    undefined,
  );
  assert.deepEqual(pinned, { session: 'demo', target: { kind: 'ref', ref: '@e2~s7' } });
});
