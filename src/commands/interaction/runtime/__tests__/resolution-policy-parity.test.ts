import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import {
  SELECTOR_RESOLUTION_POLICIES,
  selectorResolutionKnobs,
  type SelectorResolutionPolicy,
} from '@agent-device/selectors';

/**
 * The matrix in resolution-policy.ts is a claim about the callers, so it is
 * gate-tested against them rather than trusted (ADR 0011's declared-plus-
 * gate-tested pattern). Two failure modes this catches: a policy row whose
 * knobs stop matching the ambiguity contract it names, and a structural
 * column (occlusion / off-screen / promotion / poll) drifting into fiction
 * because a caller stopped importing the machinery the row advertises.
 */

const REPO_SRC = path.resolve(import.meta.dirname, '../../../..');

function readSource(relative: string): string {
  return readFileSync(path.join(REPO_SRC, relative), 'utf8');
}

const CALLERS = {
  act: 'commands/interaction/runtime/resolution.ts',
  actCoveredDiagnosis: 'commands/interaction/runtime/resolution.ts',
  readText: 'commands/interaction/runtime/selector-read.ts',
  readUnique: 'commands/interaction/runtime/selector-read.ts',
  readAny: 'commands/interaction/runtime/selector-read.ts',
  wait: 'commands/interaction/runtime/selector-wait.ts',
  findAct: 'daemon/handlers/find.ts',
} as const satisfies Record<keyof typeof SELECTOR_RESOLUTION_POLICIES, string>;

// What each structural column means in caller source, so the claim is
// checkable rather than decorative.
const OCCLUSION_MARKERS = ['isSnapshotNodeInteractionBlocked', 'interactableSelectorNodes'];
const OFFSCREEN_MARKERS = ['throwIfOffscreenInteractionTarget', 'assertVisibleSelectorTarget'];
const PROMOTION_MARKERS = ['resolveActionableTouchNode', 'resolveActionableNodeOrThrow'];
const POLL_MARKERS = ['createWaitPolling'];

function mentionsAny(source: string, markers: readonly string[]): boolean {
  return markers.some((marker) => source.includes(marker));
}

test('every policy row names a real caller', () => {
  assert.deepEqual(Object.keys(SELECTOR_RESOLUTION_POLICIES).sort(), Object.keys(CALLERS).sort());
});

test('knobs match the ambiguity contract each row names', () => {
  const expected: Record<string, ReturnType<typeof selectorResolutionKnobs>> = {
    disambiguate: { requireRect: false, requireUnique: true, disambiguateAmbiguous: true },
    'fail-closed': { requireRect: false, requireUnique: true, disambiguateAmbiguous: false },
    'first-match': { requireRect: false, requireUnique: false },
  };
  for (const [name, policy] of Object.entries(SELECTOR_RESOLUTION_POLICIES)) {
    if (policy.ambiguity === 'reject-candidates') continue;
    const knobs = selectorResolutionKnobs(policy);
    const want = { ...expected[policy.ambiguity], requireRect: policy.requireRect };
    assert.deepEqual(knobs, want, name);
  }
});

test('acting policies require a rect; read and wait policies do not', () => {
  assert.equal(SELECTOR_RESOLUTION_POLICIES.act.requireRect, true);
  assert.equal(SELECTOR_RESOLUTION_POLICIES.findAct.requireRect, true);
  assert.equal(SELECTOR_RESOLUTION_POLICIES.readUnique.requireRect, false);
  assert.equal(SELECTOR_RESOLUTION_POLICIES.readAny.requireRect, false);
  assert.equal(SELECTOR_RESOLUTION_POLICIES.wait.requireRect, false);
});

test('is/get-attrs fail closed and wait never disambiguates (the by-design asymmetry)', () => {
  assert.equal(SELECTOR_RESOLUTION_POLICIES.readUnique.ambiguity, 'fail-closed');
  assert.equal(SELECTOR_RESOLUTION_POLICIES.readAny.ambiguity, 'first-match');
  assert.equal(SELECTOR_RESOLUTION_POLICIES.wait.ambiguity, 'first-match');
  assert.equal(SELECTOR_RESOLUTION_POLICIES.act.ambiguity, 'disambiguate');
  assert.equal(SELECTOR_RESOLUTION_POLICIES.readText.ambiguity, 'disambiguate');
  assert.equal(SELECTOR_RESOLUTION_POLICIES.findAct.ambiguity, 'reject-candidates');
});

test('structural columns match what each caller actually imports', () => {
  const sources = new Map<string, string>();
  for (const relative of Object.values(CALLERS)) {
    if (!sources.has(relative)) sources.set(relative, readSource(relative));
  }
  for (const [name, relative] of Object.entries(CALLERS)) {
    const policy: SelectorResolutionPolicy =
      SELECTOR_RESOLUTION_POLICIES[name as keyof typeof SELECTOR_RESOLUTION_POLICIES];
    const source = sources.get(relative)!;
    if (policy.occlusion) {
      assert.ok(mentionsAny(source, OCCLUSION_MARKERS), `${name} claims occlusion`);
    }
    if (policy.offscreenGuard) {
      assert.ok(mentionsAny(source, OFFSCREEN_MARKERS), `${name} claims an off-screen guard`);
    }
    if (policy.promotion) {
      assert.ok(mentionsAny(source, PROMOTION_MARKERS), `${name} claims promotion`);
    }
    if (policy.poll === 'wait-budget') {
      assert.ok(mentionsAny(source, POLL_MARKERS), `${name} claims a poll budget`);
    }
  }
});

test('read and wait pipelines really do skip occlusion, off-screen, and promotion', () => {
  // The inverse direction: a row claiming NO occlusion must not sit in a file
  // that performs it, or the matrix would under-report real behavior.
  const readSourceText = readSource(CALLERS.readUnique);
  const waitSource = readSource(CALLERS.wait);
  for (const [name, source] of [
    ['selector-read', readSourceText],
    ['selector-wait', waitSource],
  ] as const) {
    assert.equal(mentionsAny(source, OCCLUSION_MARKERS), false, `${name} occlusion`);
    assert.equal(mentionsAny(source, OFFSCREEN_MARKERS), false, `${name} off-screen`);
    assert.equal(mentionsAny(source, PROMOTION_MARKERS), false, `${name} promotion`);
  }
});

test('no caller re-declares ambiguity knobs as inline literals', () => {
  for (const relative of new Set(Object.values(CALLERS))) {
    const source = readSource(relative);
    assert.equal(
      /disambiguateAmbiguous:\s*(true|false)/.test(source),
      false,
      `${relative} declares disambiguateAmbiguous inline`,
    );
    assert.equal(
      /requireUnique:\s*(true|false)/.test(source),
      false,
      `${relative} declares requireUnique inline`,
    );
  }
});
