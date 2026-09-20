import { expect, test } from 'vitest';
import { FOLD_POSES, foldPoseForHingeAngle, parseFoldPose } from './device-rotation.ts';

test('parses the three poses and the aliases an agent is likely to type', () => {
  expect(parseFoldPose('closed')).toBe('closed');
  expect(parseFoldPose('Folded')).toBe('closed');
  expect(parseFoldPose('half-open')).toBe('half-open');
  expect(parseFoldPose('book')).toBe('half-open');
  expect(parseFoldPose('half-unfolded')).toBe('half-open');
  expect(parseFoldPose('open')).toBe('open');
  expect(parseFoldPose('unfolded')).toBe('open');
  expect(parseFoldPose(' OPEN ')).toBe('open');
});

test('refuses a missing or unknown pose with the usage the CLI prints', () => {
  expect(() => parseFoldPose(undefined)).toThrow(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      message: expect.stringContaining('closed|half-open|open'),
    }),
  );
  expect(() => parseFoldPose('sideways')).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS', message: expect.stringContaining('sideways') }),
  );
});

test('reads a pose from the hinge angle with closed and open as the two fixed points', () => {
  // The Device Hub presets measured on the iOS 27.1 Duo: Closed 0°, Book 130°, Open 180°.
  expect(foldPoseForHingeAngle(0)).toBe('closed');
  expect(foldPoseForHingeAngle(130)).toBe('half-open');
  expect(foldPoseForHingeAngle(180)).toBe('open');
  // A hinge caught mid-animation is partially open, which is exactly why the verifier polls.
  expect(foldPoseForHingeAngle(95.7)).toBe('half-open');
  expect(foldPoseForHingeAngle(166)).toBe('half-open');
  expect(foldPoseForHingeAngle(Number.NaN)).toBeUndefined();
  for (const pose of FOLD_POSES) expect(FOLD_POSES).toContain(pose);
});
