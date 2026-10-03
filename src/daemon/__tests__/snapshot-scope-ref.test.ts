import { expect, test } from 'vitest';
import { STALE_REF_HINT } from '@agent-device/selectors';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { resolveSnapshotScope } from '../snapshot-capture.ts';
import { makeAndroidSession } from '../../__tests__/test-utils/session-factories.ts';

const rect = { x: 0, y: 0, width: 100, height: 100 };
const labeled = () =>
  makeSnapshotState([{ index: 0, depth: 0, type: 'Button', label: 'Continue', rect }]);
const unlabeled = () => makeSnapshotState([{ index: 0, depth: 0, type: 'Other', rect }]);

test('a scope ref the stored tree no longer lists is refused with ref_not_found', () => {
  const response = resolveSnapshotScope(
    '@e9',
    makeAndroidSession('scope', { snapshot: labeled() }),
  );

  expect(response).toEqual({
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message: 'Ref @e9 not found',
      hint: STALE_REF_HINT,
      details: { reason: 'ref_not_found', ref: 'e9' },
    },
  });
});

test('a scope ref naming a node without a label is refused with ref_unlabeled', () => {
  const snapshot = unlabeled();
  const ref = snapshot.nodes[0]!.ref;

  const response = resolveSnapshotScope(`@${ref}`, makeAndroidSession('scope', { snapshot }));

  expect(response).toMatchObject({
    ok: false,
    error: { code: 'COMMAND_FAILED', details: { reason: 'ref_unlabeled', ref } },
  });
});

test('a scope ref with a label resolves to that label', () => {
  const snapshot = labeled();
  const ref = snapshot.nodes[0]!.ref;

  expect(resolveSnapshotScope(`@${ref}`, makeAndroidSession('scope', { snapshot }))).toEqual({
    ok: true,
    scope: 'Continue',
  });
});
