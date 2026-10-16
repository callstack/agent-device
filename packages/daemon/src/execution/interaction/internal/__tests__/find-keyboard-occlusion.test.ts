import { test, expect, vi, beforeEach } from 'vitest';
import { keyboardCoveredTabBarSnapshot } from '@agent-device/test-kit';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import {
  mockFocusPoint,
  resetFindTouchRuntimeFixture,
  runFindClickScenario,
} from './find-touch-runtime-fixture.ts';
import { mockTypeText } from '../../../__tests__/interaction-get-runtime-fixture.ts';
import { refFrameState } from '../../../../core/ref-frame.ts';

vi.mock('../../../../core/snapshot-interactor-capture.ts', async () => {
  const fixture = await import('../../../../__tests__/support/legacy-snapshot-capture-fixture.ts');
  return { captureSnapshotWithInteractor: fixture.captureSnapshotThroughLegacyDispatchFixture };
});

beforeEach(() => {
  resetFindTouchRuntimeFixture();
});

function keyboardTree(targetRect?: SnapshotState['nodes'][number]['rect']): SnapshotState {
  return keyboardCoveredTabBarSnapshot(targetRect ? { targetRect } : {});
}

type Refusal = {
  code?: string;
  message?: string;
  hint?: string;
  details?: Record<string, unknown>;
};

function assertKeyboardRefusal(
  response: { ok: boolean; error?: Refusal },
  verb: string,
): asserts response {
  expect(response.ok).toBe(false);
  const error = response.error as Refusal;
  expect(error.code).toBe('COMMAND_FAILED');
  expect(error.message).toBe(`Ref @e2 is behind the visible keyboard and cannot ${verb} safely`);
  expect(error.details?.reason).toBe('tap_keyboard_occludes_target');
  expect(error.details?.ref).toBe('@e2');
  expect(error.details?.rect).toEqual({ x: 148, y: 791, width: 104, height: 83 });
  expect(error.details?.keyboardFrame).toEqual({ x: 0, y: 583, width: 402, height: 291 });
  expect(error.details?.dispatched).toBe('no');
  expect(error.hint).toMatch(/End editing first/);
}

test('find focus refuses a match whose tap point sits behind the visible keyboard', async () => {
  const { response, session } = await runFindClickScenario({
    positionals: ['Form', 'focus'],
    nodes: keyboardTree().nodes,
  });

  assertKeyboardRefusal(response, 'be focused');
  expect(mockFocusPoint).not.toHaveBeenCalled();
  // ADR 0014: the refusal is pre-action, so the captured frame stays pinnable.
  expect(refFrameState(session)).toBe('active');
});

test('find type refuses before the focus or the text dispatch', async () => {
  const { response, session } = await runFindClickScenario({
    positionals: ['Form', 'type', 'hello'],
    nodes: keyboardTree().nodes,
  });

  assertKeyboardRefusal(response, 'be focused');
  expect(mockFocusPoint).not.toHaveBeenCalled();
  expect(mockTypeText).not.toHaveBeenCalled();
  expect(refFrameState(session)).toBe('active');
});

test('find focus on a match above the keyboard band still focuses', async () => {
  const { response, session } = await runFindClickScenario({
    positionals: ['Form', 'focus'],
    nodes: keyboardTree({ x: 148, y: 470, width: 104, height: 110 }).nodes,
  });

  expect(response.ok).toBe(true);
  expect(mockFocusPoint).toHaveBeenCalledTimes(1);
  expect(refFrameState(session)).toBe('expired');
});

test('find focus on a reported keyboard key still focuses it', async () => {
  // The closest negative: the same guard excuses the keyboard's own control, which sits inside the
  // band it would otherwise refuse.
  const { response } = await runFindClickScenario({
    positionals: ['label', 'space', 'focus'],
    nodes: keyboardTree().nodes,
  });

  expect(response.ok).toBe(true);
  expect(mockFocusPoint).toHaveBeenCalledTimes(1);
});
