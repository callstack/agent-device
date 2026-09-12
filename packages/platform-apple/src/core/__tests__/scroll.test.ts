import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { SCROLL_KEYBOARD_OCCLUDES_SURFACE_REASON } from '@agent-device/contracts/scroll-gesture';
import {
  normalizeAppleScrollResultWithResolvedFrame,
  withAppleScrollKeyboardOcclusion,
} from '../scroll.ts';

const RUNNER_OCCLUSION_CODE = 'SCROLL_KEYBOARD_OCCLUDES_SURFACE';

function runnerOcclusionError(): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'scroll down refused: the keyboard leaves 28pt of surface',
    {
      runnerErrorCode: RUNNER_OCCLUSION_CODE,
      logPath: '/tmp/runner.log',
    },
  );
}

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

test('the runner keyboard refusal becomes the typed reason a caller can branch on', () => {
  const mapped = withAppleScrollKeyboardOcclusion(runnerOcclusionError(), 'down');
  assert.ok(mapped instanceof AppError);
  assert.equal(mapped.code, 'COMMAND_FAILED');
  assert.equal(mapped.details?.reason, SCROLL_KEYBOARD_OCCLUDES_SURFACE_REASON);
  assert.match(String(mapped.details?.hint), /keyboard dismiss/);
});

test('the mapped refusal keeps the transport diagnostics the original error carried', () => {
  const mapped = withAppleScrollKeyboardOcclusion(runnerOcclusionError(), 'down');
  assert.ok(mapped instanceof AppError);
  assert.equal(mapped.details?.logPath, '/tmp/runner.log');
  assert.equal(mapped.details?.runnerErrorCode, RUNNER_OCCLUSION_CODE);
});

test('the nearest negatives stay untouched, so only the refusal code renames an error', () => {
  // Same code, different classification: a generic scroll failure must not read as an occlusion, or
  // the caller would be told to dismiss a keyboard that is not in the way.
  const generic = new AppError(
    'COMMAND_FAILED',
    'scroll could not resolve a usable interaction frame',
    {
      logPath: '/tmp/runner.log',
    },
  );
  assert.equal(withAppleScrollKeyboardOcclusion(generic, 'down'), generic);
  const transport = new Error('socket hang up');
  assert.equal(withAppleScrollKeyboardOcclusion(transport, 'down'), transport);
  const alert = new AppError('COMMAND_FAILED', 'no alert', { runnerErrorCode: 'ALERT_NOT_FOUND' });
  assert.equal(withAppleScrollKeyboardOcclusion(alert, 'down'), alert);
});
