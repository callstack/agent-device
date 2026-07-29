import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  captureScrollEdgeState,
  formatScrollEdgeMessage,
  runScrollEdgePasses,
} from './scroll-edge-state.ts';
import { AppError } from '../kernel/errors.ts';
import { captureThrows, scrollSnapshot, windowRoot } from './scroll-edge-state-fixtures.ts';

// ---------------------------------------------------------------------------
// formatScrollEdgeMessage — pure formatter, 5 mutually exclusive branches
// ---------------------------------------------------------------------------

test('formatScrollEdgeMessage: edge reached with zero passes reports already-at-edge (bottom)', () => {
  assert.equal(
    formatScrollEdgeMessage('down', 'bottom', 0, undefined, undefined),
    'Already at bottom; no hidden content below detected',
  );
});

test('formatScrollEdgeMessage: edge reached with zero passes reports already-at-edge (top)', () => {
  assert.equal(
    formatScrollEdgeMessage('up', 'top', 0, undefined, undefined),
    'Already at top; no hidden content above detected',
  );
});

test('formatScrollEdgeMessage: edge reached after N passes', () => {
  assert.equal(
    formatScrollEdgeMessage('down', 'bottom', 4, undefined, undefined),
    'Scrolled to bottom with 4 down passes',
  );
});

test('formatScrollEdgeMessage: no edge, pixel amount given', () => {
  assert.equal(
    formatScrollEdgeMessage('down', undefined, 0, undefined, 250),
    'Scrolled down by 250px',
  );
});

test('formatScrollEdgeMessage: no edge, no pixels, symbolic amount given', () => {
  assert.equal(formatScrollEdgeMessage('up', undefined, 0, 3, undefined), 'Scrolled up by 3');
});

test('formatScrollEdgeMessage: no edge, no pixels, no amount falls back to bare direction', () => {
  assert.equal(
    formatScrollEdgeMessage('left', undefined, 0, undefined, undefined),
    'Scrolled left',
  );
});

test('formatScrollEdgeMessage: pixels takes priority over amount when both are set', () => {
  assert.equal(formatScrollEdgeMessage('down', undefined, 0, 3, 250), 'Scrolled down by 250px');
});

// ---------------------------------------------------------------------------
// captureScrollEdgeState: retry-without-scope on an empty scoped capture
// ---------------------------------------------------------------------------

test('captureScrollEdgeState: an empty scoped capture retries exactly once, without the scope', async () => {
  const calls: (string | undefined)[] = [];
  const nodes = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      hiddenContentBelow: true,
      rect: { x: 0, y: 100, width: 400, height: 600 },
    },
  ];

  const state = await captureScrollEdgeState({
    edge: 'bottom',
    scope: 'stale-scope',
    captureNodes: async (scope) => {
      calls.push(scope);
      return scope ? [] : nodes;
    },
  });

  assert.deepEqual(calls, ['stale-scope', undefined]);
  assert.equal(state.canScroll, true);
  assert.equal(state.emptySnapshot, false);
});

test('captureScrollEdgeState: an empty capture with no scope does not retry', async () => {
  let callCount = 0;
  const state = await captureScrollEdgeState({
    edge: 'bottom',
    captureNodes: async () => {
      callCount += 1;
      return [];
    },
  });
  assert.equal(callCount, 1);
  assert.equal(state.emptySnapshot, true);
});

// ---------------------------------------------------------------------------
// captureScrollEdgeState: error wrapping
// ---------------------------------------------------------------------------

test('captureScrollEdgeState: a captureNodes failure is wrapped in a COMMAND_FAILED AppError, scoped variant', async () => {
  const original = new Error('runner timed out');
  await assert.rejects(
    captureScrollEdgeState({
      edge: 'bottom',
      scope: 'feed',
      captureNodes: async () => {
        throw original;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.message, 'Failed to verify scroll bottom state for scoped container');
      assert.deepEqual(error.details, {
        scope: 'feed',
        hint: 'scroll bottom could not verify the scoped scroll container. Run snapshot -i for the current screen and retry with a visible scroll target.',
      });
      assert.equal(error.cause, original);
      return true;
    },
  );
});

test('captureScrollEdgeState: a captureNodes failure is wrapped in a COMMAND_FAILED AppError, unscoped variant (bottom edge)', async () => {
  const original = new Error('runner timed out');
  await assert.rejects(
    captureScrollEdgeState({
      edge: 'bottom',
      captureNodes: async () => {
        throw original;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.message, 'Failed to verify scroll bottom state');
      assert.deepEqual(error.details, {
        hint: 'scroll bottom needs a snapshot showing hidden content below before it will move.',
      });
      assert.equal(error.cause, original);
      return true;
    },
  );
});

test('captureScrollEdgeState: a captureNodes failure is wrapped in a COMMAND_FAILED AppError, unscoped variant (top edge)', async () => {
  const original = new Error('runner timed out');
  await assert.rejects(
    captureScrollEdgeState({
      edge: 'top',
      captureNodes: async () => {
        throw original;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.message, 'Failed to verify scroll top state');
      assert.deepEqual(error.details, {
        hint: 'scroll top needs a snapshot showing hidden content above before it will move.',
      });
      assert.equal(error.cause, original);
      return true;
    },
  );
});

test('captureScrollEdgeState: the scoped and unscoped error messages are distinct', async () => {
  const scopedError = await captureThrows('feed');
  const unscopedError = await captureThrows(undefined);
  assert.notEqual(scopedError.message, unscopedError.message);
});

// ---------------------------------------------------------------------------
// runScrollEdgePasses
// ---------------------------------------------------------------------------

test('runScrollEdgePasses: zero passes when the initial capture already cannot scroll', async () => {
  let scrollCalls = 0;
  let captureCalls = 0;
  const result = await runScrollEdgePasses({
    edge: 'bottom',
    captureState: async () => {
      captureCalls += 1;
      return { canScroll: false, emptySnapshot: false };
    },
    scroll: async () => {
      scrollCalls += 1;
      return 'scrolled';
    },
  });
  assert.deepEqual(result, { passes: 0, result: undefined });
  assert.equal(scrollCalls, 0);
  // No scope was reported, so the pre-loop rescope must NOT fire a second capture.
  assert.equal(captureCalls, 1);
});

test('runScrollEdgePasses: threads the discovered scope into every subsequent capture, and stops once canScroll flips false', async () => {
  const scopeCalls: (string | undefined)[] = [];
  let scrollCalls = 0;
  let captureCalls = 0;

  const result = await runScrollEdgePasses<{ index: number }>({
    edge: 'bottom',
    captureState: async (scope) => {
      scopeCalls.push(scope);
      captureCalls += 1;
      // capture #1: initial unscoped probe discovers the scope.
      // capture #2: immediate rescope before the loop starts.
      // captures #3..#5: one per completed pass; the 5th reports canScroll: false.
      const canScroll = captureCalls < 5;
      return { canScroll, emptySnapshot: false, scope: 'feed' };
    },
    scroll: async () => {
      scrollCalls += 1;
      return { index: scrollCalls };
    },
  });

  assert.equal(scrollCalls, 3);
  assert.equal(result.passes, 3);
  assert.deepEqual(result.result, { index: 3 });
  assert.deepEqual(scopeCalls, [undefined, 'feed', 'feed', 'feed', 'feed']);
});

test('runScrollEdgePasses: a scope reported alongside canScroll:false still triggers the pre-loop rescope, but the loop never runs', async () => {
  // The pre-loop rescope only checks state.scope, not state.canScroll — so it fires
  // even though the very first (unscoped) capture already reports canScroll: false.
  const scopeCalls: (string | undefined)[] = [];
  let scrollCalls = 0;

  const result = await runScrollEdgePasses({
    edge: 'bottom',
    captureState: async (scope) => {
      scopeCalls.push(scope);
      return {
        canScroll: false,
        emptySnapshot: false,
        scope: 'feed',
      };
    },
    scroll: async () => {
      scrollCalls += 1;
      return 'x';
    },
  });

  assert.deepEqual(scopeCalls, [undefined, 'feed']);
  assert.equal(scrollCalls, 0);
  assert.equal(result.passes, 0);
});

test('runScrollEdgePasses: throws a COMMAND_FAILED AppError once the pass limit is reached while canScroll stays true', async () => {
  let scrollCalls = 0;
  await assert.rejects(
    runScrollEdgePasses({
      edge: 'bottom',
      captureState: async () => ({
        canScroll: true,
        emptySnapshot: false,
      }),
      scroll: async () => {
        scrollCalls += 1;
        return undefined;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(
        error.message,
        'scroll bottom reached the safety limit before the snapshot showed the edge',
      );
      assert.deepEqual(error.details, {
        hint: 'The scoped scroll container still reports hidden content. Use a smaller manual scroll + snapshot loop to inspect the current state.',
      });
      return true;
    },
  );
  assert.equal(scrollCalls, 40);
});

test('unique container scope is retained across edge pass captures', async () => {
  const scopes: Array<string | undefined> = [];
  const snapshots = [scrollSnapshot(true), scrollSnapshot(true), scrollSnapshot(false)];
  let captureIndex = 0;

  const result = await runScrollEdgePasses({
    edge: 'bottom',
    captureState: async (scope) =>
      await captureScrollEdgeState({
        edge: 'bottom',
        scope,
        captureNodes: async (capturedScope) => {
          scopes.push(capturedScope);
          return snapshots[Math.min(captureIndex++, snapshots.length - 1)] ?? [];
        },
      }),
    scroll: async () => ({ scrolled: true }),
  });

  assert.equal(result.passes, 1);
  assert.deepEqual(scopes, [undefined, 'Messages', 'Messages']);
});
