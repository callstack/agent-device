import { test } from 'vitest';
import assert from 'node:assert/strict';
import type {
  Point,
  Rect,
  SnapshotAddressableNode,
  SnapshotKeyboardBandFact,
  SnapshotState,
} from '@agent-device/kernel/snapshot';
import { TAP_KEYBOARD_OCCLUDES_TARGET_DETAILS } from '@agent-device/contracts/tap-keyboard-occlusion';
import {
  KEYBOARD_COVERED_BAND_RECT,
  KEYBOARD_COVERED_TAB_BAR_RECT,
  keyboardCoveredTabBarSnapshot,
} from '@agent-device/test-kit';
import {
  assertTapTargetClearOfVisibleKeyboard,
  describeKeyboardOccludedPointWarning,
} from './keyboard-occlusion.ts';

// The guard's own two contributions: the refusal it raises for a decision the classifier already
// made, and the disclosure string it composes. Which geometry decides is the classifier's suite
// (packages/contracts/src/tap-keyboard-occlusion.test.ts, golden-table-driven), and which doors run
// the guard is proven where each door lives — the interaction leaf's in
// src/commands/interaction/runtime/target-visibility-stages-keyboard-occlusion.test.ts, the
// mutating-`find` seam's in packages/daemon/src/execution/interaction/internal/__tests__/. Every one
// of those suites measures this same #2589 capture.

function centerOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function addressableNode(snapshot: SnapshotState, index: number): SnapshotAddressableNode {
  const node = snapshot.nodes.find((candidate) => candidate.index === index);
  assert.ok(node && 'ref' in node && node.ref, `expected node ${index} to carry a ref`);
  return node as SnapshotAddressableNode;
}

/**
 * The guard as a caller runs it: against the node it resolved, at the point it would tap. Omitting
 * `tapPoint` taps that node's own center.
 */
function guard(params: {
  snapshot: SnapshotState;
  index?: number;
  action?: 'click' | 'fill' | 'focus';
  label?: string;
  keyboard?: SnapshotKeyboardBandFact;
  tapPoint?: Point | null;
}): void {
  const node = addressableNode(params.snapshot, params.index ?? 1);
  assertTapTargetClearOfVisibleKeyboard({
    nodes: params.snapshot.nodes,
    node,
    action: params.action ?? 'click',
    label: params.label ?? 'Ref @e2',
    ...(params.keyboard ? { keyboard: params.keyboard } : {}),
    tapPoint:
      params.tapPoint === undefined && node.rect ? centerOf(node.rect) : (params.tapPoint ?? null),
  });
}

/** Runs the guard expecting a refusal, and hands back that refusal's message and typed details. */
function keyboardRefusalDetails(params: Parameters<typeof guard>[0]): {
  message: string;
  details: Record<string, unknown>;
} {
  let message = '';
  let details: Record<string, unknown> | undefined;
  assert.throws(
    () => guard(params),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
      assert.match(error.message, /Ref @e2 is behind the visible keyboard/);
      message = error.message;
      details = (error as { details?: Record<string, unknown> }).details;
      return true;
    },
  );
  assert.ok(details, 'the refusal carries details');
  return { message, details };
}

test('the refusal carries the shared reason, the target, and the band it measured', () => {
  assert.deepEqual(keyboardRefusalDetails({ snapshot: keyboardCoveredTabBarSnapshot() }).details, {
    ...TAP_KEYBOARD_OCCLUDES_TARGET_DETAILS,
    ref: '@e2',
    rect: KEYBOARD_COVERED_TAB_BAR_RECT,
    keyboardFrame: KEYBOARD_COVERED_BAND_RECT,
    dispatched: 'no',
  });
});

test('the refusal names the action it declined', () => {
  for (const [action, verb] of [
    ['click', 'be tapped'],
    ['fill', 'be filled'],
    ['focus', 'be focused'],
  ] as const) {
    // Each iteration runs the full typed refusal — code, reason, dispatched: 'no' — so the verb
    // check cannot pass on an unrelated rejection that merely mentions the action.
    const { message, details } = keyboardRefusalDetails({
      snapshot: keyboardCoveredTabBarSnapshot(),
      action,
    });
    assert.equal(details.reason, 'tap_keyboard_occludes_target');
    assert.equal(details.dispatched, 'no');
    assert.match(
      message,
      new RegExp(`cannot ${verb} safely`),
      `${action} refuses with the "${verb}" verb`,
    );
  }
});

test('the refusal quotes how the caller named the target', () => {
  assert.throws(
    () => guard({ snapshot: keyboardCoveredTabBarSnapshot(), label: 'Selector label=Form' }),
    /Selector label=Form is behind the visible keyboard/,
  );
});

test('a target with no measurable point cannot be refused', () => {
  guard({ snapshot: keyboardCoveredTabBarSnapshot(), tapPoint: null });
});

// The coordinate path discloses the same decision instead of refusing it, in one string the
// response publishes.

function pointWarning(params: {
  snapshot: SnapshotState;
  point: Point;
  keyboard?: SnapshotKeyboardBandFact;
}): string | undefined {
  return describeKeyboardOccludedPointWarning({
    nodes: params.snapshot.nodes,
    point: params.point,
    viewport: params.snapshot.nodes[0]!.rect ?? null,
    ...(params.keyboard ? { keyboard: params.keyboard } : {}),
  });
}

test('a coordinate behind the keyboard discloses the point, reason, and band', () => {
  const warning = pointWarning({
    snapshot: keyboardCoveredTabBarSnapshot(),
    point: { x: 200, y: 810 },
  });
  assert.match(warning ?? '', /\(200, 810\) is behind the visible keyboard/);
  assert.match(warning ?? '', /tap_keyboard_occludes_target/);
  assert.match(warning ?? '', /keyboard frame 583\.\.874/);
});

test('a coordinate on a reported key discloses nothing', () => {
  assert.equal(
    pointWarning({ snapshot: keyboardCoveredTabBarSnapshot(), point: { x: 160, y: 760 } }),
    undefined,
  );
});
