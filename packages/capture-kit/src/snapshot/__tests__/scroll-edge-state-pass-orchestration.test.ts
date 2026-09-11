import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  captureScrollEdgeState,
  formatScrollEdgeMessage,
  runScrollEdgePasses,
} from '../scroll-edge-state.ts';
import { AppError } from '@agent-device/kernel/errors';
import { captureThrows, scrollSnapshot, windowRoot } from './scroll-edge-state-fixtures.ts';

// ---------------------------------------------------------------------------
// formatScrollEdgeMessage — pure formatter, 5 mutually exclusive branches
// ---------------------------------------------------------------------------

test('formatScrollEdgeMessage: edge reached with zero passes reports already-at-edge (bottom)', () => {
  assert.equal(
    formatScrollEdgeMessage({ direction: 'down', edge: 'bottom', passes: 0 }),
    'Already at bottom; no hidden content below detected',
  );
});

test('formatScrollEdgeMessage: edge reached with zero passes reports already-at-edge (top)', () => {
  assert.equal(
    formatScrollEdgeMessage({ direction: 'up', edge: 'top', passes: 0 }),
    'Already at top; no hidden content above detected',
  );
});

test('formatScrollEdgeMessage: edge reached after N passes', () => {
  assert.equal(
    formatScrollEdgeMessage({ direction: 'down', edge: 'bottom', passes: 4 }),
    'Scrolled to bottom with 4 down passes',
  );
});

test('formatScrollEdgeMessage: no edge, pixel amount given', () => {
  assert.equal(
    formatScrollEdgeMessage({ direction: 'down', passes: 0, pixels: 250 }),
    'Scrolled down by 250px',
  );
});

test('formatScrollEdgeMessage: no edge, no pixels, symbolic amount given', () => {
  assert.equal(
    formatScrollEdgeMessage({ direction: 'up', passes: 0, amount: 3 }),
    'Scrolled up by 3',
  );
});

test('formatScrollEdgeMessage: no edge, no pixels, no amount falls back to bare direction', () => {
  assert.equal(formatScrollEdgeMessage({ direction: 'left', passes: 0 }), 'Scrolled left');
});

test('formatScrollEdgeMessage: pixels takes priority over amount when both are set', () => {
  assert.equal(
    formatScrollEdgeMessage({ direction: 'down', passes: 0, amount: 3, pixels: 250 }),
    'Scrolled down by 250px',
  );
});

/**
 * One gesture saturates at the viewport axis minus its edge padding, so a large amount buys less
 * travel than it names. The message reports what the planner honored rather than what was asked.
 */
test('an amount-based message names the honored travel when the planner reports it', () => {
  assert.equal(
    formatScrollEdgeMessage({ direction: 'down', passes: 1, amount: 3, honoredPixels: 640 }),
    'Scrolled down by 3 of the viewport (640px)',
  );
  assert.equal(
    formatScrollEdgeMessage({ direction: 'down', passes: 1, amount: 0.65 }),
    'Scrolled down by 0.65',
  );
  assert.equal(
    formatScrollEdgeMessage({ direction: 'down', passes: 1, pixels: 5000, honoredPixels: 640 }),
    'Scrolled down by 640px',
  );
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
      // No fingerprint on these manual captures, so no-progress detection is inert and only the
      // 40-pass backstop can end the loop. The real capture path always sets a fingerprint.
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
      assert.equal(error.details?.reason, 'scroll_edge_pass_limit');
      assert.equal(error.details?.passes, 40);
      assert.match(String(error.details?.hint), /--until <selector>/);
      return true;
    },
  );
  assert.equal(scrollCalls, 40);
});

test('runScrollEdgePasses: stops as no-progress after a couple of passes when the fingerprint never moves', async () => {
  let scrollCalls = 0;
  await assert.rejects(
    runScrollEdgePasses({
      edge: 'bottom',
      // canScroll stays true but the surface fingerprint is byte-identical every capture — the
      // stuck-container signature (the gesture is not reaching this scroll view).
      captureState: async () => ({
        canScroll: true,
        emptySnapshot: false,
        fingerprint: 'stuck-surface',
      }),
      scroll: async () => {
        scrollCalls += 1;
        return undefined;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.reason, 'scroll_edge_no_progress');
      assert.equal(error.details?.edge, 'bottom');
      assert.match(String(error.details?.hint), /not reaching this container/);
      return true;
    },
  );
  // The whole point: a stuck container stops within a few flings, not 40.
  assert.equal(scrollCalls, 3);
});

test('runScrollEdgePasses: a moving fingerprint never trips no-progress and scrolls to the edge', async () => {
  let scrollCalls = 0;
  const result = await runScrollEdgePasses({
    edge: 'bottom',
    captureState: async () => ({
      canScroll: scrollCalls < 5,
      emptySnapshot: false,
      fingerprint: `surface-${scrollCalls}`,
    }),
    scroll: async () => {
      scrollCalls += 1;
      return undefined;
    },
  });
  assert.equal(result.passes, 5);
});

test('runScrollEdgePasses: a fresh surface signature continues after identical passes', async () => {
  let scrollCalls = 0;
  // The surface sits at `a` for three captures, then a pass finally reveals `b`. `b` is a signature
  // the window has not seen, so the loop keeps going rather than stopping as no-progress on the pass
  // that actually advanced.
  const captures = [
    { canScroll: true, fingerprint: 'a' },
    { canScroll: true, fingerprint: 'a' },
    { canScroll: true, fingerprint: 'a' },
    { canScroll: true, fingerprint: 'b' },
    { canScroll: false, fingerprint: 'b' },
  ];
  let index = 0;
  const result = await runScrollEdgePasses({
    edge: 'bottom',
    captureState: async () => ({
      emptySnapshot: false,
      ...(captures[index++] ?? { canScroll: false }),
    }),
    scroll: async () => {
      scrollCalls += 1;
      return undefined;
    },
  });
  assert.equal(result.passes, 4);
  assert.equal(scrollCalls, 4);
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
