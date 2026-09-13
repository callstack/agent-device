import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { SCROLL_KEYBOARD_OCCLUDES_SURFACE_REASON } from '@agent-device/contracts/scroll-gesture';
import {
  normalizeAppleScrollResultWithResolvedFrame,
  withAppleScrollKeyboardOcclusion,
} from '../scroll.ts';

test('a clipped runner frame yields travel and evidence for the band actually swiped', () => {
  // The runner clips the interaction frame above the keyboard and reports the clipped axis, so the
  // TS recomputation of `pixels` must be honest about the shorter travel (#2500). Reading the
  // unclipped screen height here would over-report travel the surface never had.
  const result = normalizeAppleScrollResultWithResolvedFrame(
    {
      x: 201,
      y: 500,
      x2: 201,
      y2: 100,
      referenceWidth: 402,
      referenceHeight: 552,
      keyboardAvoided: true,
      keyboardMinY: 564,
    },
    'down',
    { amount: 0.65, durationMs: 400 },
  );
  assert.equal(result.referenceHeight, 552);
  assert.equal(result.pixels, Math.round(552 * 0.65));
  assert.equal(result.keyboardAvoided, true);
  assert.equal(result.keyboardMinY, 564);
});

test('an unclipped scroll reports no avoidance evidence rather than a fabricated false', () => {
  // A plain `false` could not tell "no keyboard was up" from "this platform never runs the clip",
  // so absence is the negative case, and the schema has to keep both distinguishable.
  const result = normalizeAppleScrollResultWithResolvedFrame(
    { x: 201, y: 500, x2: 201, y2: 100, referenceWidth: 402, referenceHeight: 874 },
    'down',
    { amount: 0.65 },
  );
  assert.equal('keyboardAvoided' in result, false);
  assert.equal('keyboardMinY' in result, false);
});

test('avoidance from a runner that reports no keyboard edge is still avoidance', () => {
  // `keyboardMinY` is additive evidence; a runner build that clipped without naming the edge must not
  // lose the fact that it clipped at all.
  const result = normalizeAppleScrollResultWithResolvedFrame(
    {
      x: 201,
      y: 500,
      x2: 201,
      y2: 100,
      referenceWidth: 402,
      referenceHeight: 552,
      keyboardAvoided: true,
    },
    'down',
    { amount: 0.65 },
  );
  assert.equal(result.keyboardAvoided, true);
  assert.equal('keyboardMinY' in result, false);
});

test('the runner keyboard refusal gains the shared reason and hint and keeps its own message', () => {
  const runnerError = new AppError(
    'COMMAND_FAILED',
    'scroll down refused: the keyboard leaves 28pt of visible surface above it',
    { runnerErrorCode: 'SCROLL_KEYBOARD_OCCLUDES_SURFACE', logPath: '/tmp/runner.log' },
  );
  const mapped = withAppleScrollKeyboardOcclusion(runnerError);
  assert.ok(mapped instanceof AppError);
  assert.equal(mapped.code, 'COMMAND_FAILED');
  assert.equal(mapped.message, runnerError.message);
  assert.equal(mapped.details?.reason, SCROLL_KEYBOARD_OCCLUDES_SURFACE_REASON);
  assert.match(String(mapped.details?.hint), /keyboard dismiss/);
  assert.equal(mapped.details?.logPath, '/tmp/runner.log');
  assert.equal(mapped.details?.runnerErrorCode, 'SCROLL_KEYBOARD_OCCLUDES_SURFACE');
});

test('only the refusal code is renamed, so a generic scroll failure never reads as an occlusion', () => {
  const generic = new AppError('COMMAND_FAILED', 'scroll could not resolve a usable frame', {
    logPath: '/tmp/runner.log',
  });
  assert.equal(withAppleScrollKeyboardOcclusion(generic), generic);
  const alert = new AppError('COMMAND_FAILED', 'no alert', { runnerErrorCode: 'ALERT_NOT_FOUND' });
  assert.equal(withAppleScrollKeyboardOcclusion(alert), alert);
  const transport = new Error('socket hang up');
  assert.equal(withAppleScrollKeyboardOcclusion(transport), transport);
});
