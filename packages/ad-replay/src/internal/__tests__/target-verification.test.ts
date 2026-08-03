import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { TargetAnnotationV1 } from '@agent-device/contracts/replay';
import {
  deriveReplayTargetGuardMismatchEvidence,
  deriveWaitLandmarkMismatchEvidence,
  planPostResolutionTargetVerification,
  planPreDispatchTargetVerification,
  type AdReplayGuardMismatchEvidence,
  type AdReplayLandmarkMismatchEvidence,
} from '../target-verification.ts';
import type {
  ReplaySelectorExpressionOutcome,
  ReplaySelectorGrammar,
  ReplaySelectorPort,
} from '../selector-port.ts';

/**
 * #1555 structural-quality review ("package-local tests... target-verification.ts's
 * four policy functions; counterfactual on one"): these four functions
 * previously had no direct test coverage at package level — only
 * transitively, through `step-loop.test.ts`'s `runAdReplay` fixtures (whose
 * fake `AdReplayStepRuntime` never exercises `planPreDispatchTargetVerification`'s
 * port call at all) and the daemon's live end-to-end replay suites. This
 * file covers each function's decision surface directly.
 */

function recorded(overrides: Partial<TargetAnnotationV1> = {}): TargetAnnotationV1 {
  return {
    role: 'button',
    label: 'Save',
    ancestry: [],
    sibling: 0,
    viewportOrder: 0,
    verification: 'verified',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// planPostResolutionTargetVerification
// ---------------------------------------------------------------------------

test('planPostResolutionTargetVerification: a non-selector wait form is inert (skip), regardless of recorded verification', () => {
  assert.deepEqual(
    planPostResolutionTargetVerification({
      recorded: recorded({ verification: 'unverifiable' }),
      isSelectorWait: false,
    }),
    { kind: 'skip' },
  );
});

test('planPostResolutionTargetVerification: a selector wait with a recorded-unverifiable annotation refuses up front', () => {
  assert.deepEqual(
    planPostResolutionTargetVerification({
      recorded: recorded({ verification: 'unverifiable' }),
      isSelectorWait: true,
    }),
    { kind: 'recorded-unverifiable' },
  );
});

test('planPostResolutionTargetVerification: a selector wait with a verifiable annotation defers into the polling loop', () => {
  const landmark = recorded({ verification: 'verified' });
  assert.deepEqual(
    planPostResolutionTargetVerification({ recorded: landmark, isSelectorWait: true }),
    { kind: 'deferred-landmark', landmark },
  );
});

// ---------------------------------------------------------------------------
// planPreDispatchTargetVerification
// ---------------------------------------------------------------------------

/** A port whose `readSelectorExpression` returns a fixed outcome and records how it was called. */
function fakePort(outcome: ReplaySelectorExpressionOutcome): {
  port: ReplaySelectorPort;
  calls: Array<{ grammar: ReplaySelectorGrammar; positionals: readonly string[] }>;
} {
  const calls: Array<{ grammar: ReplaySelectorGrammar; positionals: readonly string[] }> = [];
  const port: ReplaySelectorPort = {
    readSelectorExpression: (grammar, positionals) => {
      calls.push({ grammar, positionals });
      return outcome;
    },
    resolveRecordedTarget: () => {
      throw new Error('resolveRecordedTarget: not used by planPreDispatchTargetVerification');
    },
    buildSelectorCandidates: () => {
      throw new Error('buildSelectorCandidates: not used by planPreDispatchTargetVerification');
    },
  };
  return { port, calls };
}

test('planPreDispatchTargetVerification: no recorded token means nothing to verify (skip), and the port is never called', () => {
  const { port, calls } = fakePort({ kind: 'expression', expression: 'id="x"', rest: [] });
  const plan = planPreDispatchTargetVerification({ recorded: recorded(), token: undefined, port });
  assert.deepEqual(plan, { kind: 'skip' });
  assert.deepEqual(calls, []);
});

test('planPreDispatchTargetVerification: a @ref token skips the parse gate entirely', () => {
  const { port, calls } = fakePort({ kind: 'invalid' });
  const plan = planPreDispatchTargetVerification({
    recorded: recorded(),
    token: '@e1~s0',
    port,
  });
  assert.deepEqual(plan, { kind: 'verify', token: '@e1~s0' });
  assert.deepEqual(calls, []);
});

test("planPreDispatchTargetVerification: a parseable non-@ token proceeds to 'verify' (or 'recorded-unverifiable')", () => {
  const { port } = fakePort({ kind: 'expression', expression: 'id="save"', rest: [] });
  const verify = planPreDispatchTargetVerification({
    recorded: recorded({ verification: 'verified' }),
    token: 'id="save"',
    port,
  });
  assert.deepEqual(verify, { kind: 'verify', token: 'id="save"' });

  const unverifiable = planPreDispatchTargetVerification({
    recorded: recorded({ verification: 'unverifiable' }),
    token: 'id="save"',
    port,
  });
  assert.deepEqual(unverifiable, { kind: 'recorded-unverifiable' });
});

test("planPreDispatchTargetVerification: the port is called with ('ordinary', [token]) exactly", () => {
  const { port, calls } = fakePort({ kind: 'expression', expression: 'id="save"', rest: [] });
  planPreDispatchTargetVerification({ recorded: recorded(), token: 'id="save"', port });
  assert.deepEqual(calls, [{ grammar: 'ordinary', positionals: ['id="save"'] }]);
});

// #1555 structural-quality review ("fix the engine's parse gate to honor its
// own port contract"): this is the item-2 fix's own decision surface — a
// token that fails to parse must skip pre-dispatch verification, exactly
// like the pre-fix `resolveRecordedTarget`-over-empty-nodes check did for
// `parse-invalid`. Covering BOTH non-'expression' discriminants
// ('not-applicable', the one production's 'ordinary' grammar actually
// reaches from a bare token, and 'invalid', defensively) because the fix's
// whole point is that the mapping does not hinge on which one fires.
test("planPreDispatchTargetVerification: a token that fails to parse ('not-applicable' or 'invalid') skips pre-dispatch verification", () => {
  for (const outcome of [{ kind: 'not-applicable' as const }, { kind: 'invalid' as const }]) {
    const { port } = fakePort(outcome);
    const plan = planPreDispatchTargetVerification({
      recorded: recorded({ verification: 'unverifiable' }),
      token: 'id=',
      port,
    });
    assert.deepEqual(plan, { kind: 'skip' }, `outcome ${outcome.kind} must skip`);
  }
});

// Counterfactual (docs/agents/testing.md): reverting the `parseCheck.kind !==
// 'expression'` check to `parseCheck.kind === 'invalid'` (the literal, too-
// narrow reading of "'invalid' -> skip") makes the 'not-applicable' case fall
// through to `recorded.verification === 'unverifiable'` and report
// `{ kind: 'recorded-unverifiable' }` instead of `{ kind: 'skip' }` — turning
// the cell above red. Verified by hand (see below), restored before commit.

// ---------------------------------------------------------------------------
// deriveReplayTargetGuardMismatchEvidence
// ---------------------------------------------------------------------------

test('deriveReplayTargetGuardMismatchEvidence: identical identity but differing structural position reports a position mismatch line, never an identity one', () => {
  const evidence: AdReplayGuardMismatchEvidence = {
    observed: { role: 'button', label: 'Save' },
    expectedStructural: { documentOrder: 3, sibling: 0 },
    observedStructural: { documentOrder: 7, sibling: 1 },
  };
  const result = deriveReplayTargetGuardMismatchEvidence(
    recorded({ role: 'button', label: 'Save' }),
    evidence,
    2,
  );
  assert.equal(result.matchCount, 2);
  assert.deepEqual(result.observed, evidence.observed);
  assert.deepEqual(result.mismatches, ['position: recorded=doc3/sibling0 observed=doc7/sibling1']);
});

test('deriveReplayTargetGuardMismatchEvidence: a differing observed identity reports an identity mismatch line', () => {
  const evidence: AdReplayGuardMismatchEvidence = {
    observed: { role: 'button', label: 'Cancel' },
    expectedStructural: undefined,
    observedStructural: undefined,
  };
  const result = deriveReplayTargetGuardMismatchEvidence(
    recorded({ role: 'button', label: 'Save' }),
    evidence,
    1,
  );
  assert.equal(result.mismatches.length, 1);
  assert.match(result.mismatches[0]!, /label/);
});

test('deriveReplayTargetGuardMismatchEvidence: no observed identity reports zero mismatches but still carries matchCount', () => {
  const evidence: AdReplayGuardMismatchEvidence = {
    observed: undefined,
    expectedStructural: undefined,
    observedStructural: undefined,
  };
  const result = deriveReplayTargetGuardMismatchEvidence(recorded(), evidence, 5);
  assert.equal(result.matchCount, 5);
  assert.deepEqual(result.mismatches, []);
});

// ---------------------------------------------------------------------------
// deriveWaitLandmarkMismatchEvidence
// ---------------------------------------------------------------------------

test('deriveWaitLandmarkMismatchEvidence: no observed identity reports zero mismatches', () => {
  const evidence: AdReplayLandmarkMismatchEvidence = {
    matchCount: undefined,
    observed: undefined,
    observedAncestry: [],
  };
  const result = deriveWaitLandmarkMismatchEvidence(recorded(), evidence);
  assert.deepEqual(result.mismatches, []);
  assert.equal(result.matchCount, undefined);
});

test('deriveWaitLandmarkMismatchEvidence: an observed identity combines identity and ancestry mismatches', () => {
  const evidence: AdReplayLandmarkMismatchEvidence = {
    matchCount: 3,
    observed: { role: 'button', label: 'Cancel' },
    observedAncestry: [{ role: 'dialog' }],
  };
  const result = deriveWaitLandmarkMismatchEvidence(
    recorded({ role: 'button', label: 'Save', ancestry: [{ role: 'sheet' }] }),
    evidence,
  );
  assert.equal(result.matchCount, 3);
  assert.ok(result.mismatches.some((line) => /label/.test(line)));
  assert.ok(result.mismatches.some((line) => /sheet/.test(line) || /dialog/.test(line)));
});
