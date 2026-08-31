import { expect, test } from 'vitest';
import { activatePartialRefFrame } from '../../ref-frame.ts';
import { refMutationAdmissionResponse } from '../interaction-ref-policy.ts';
import { makeStaleRefSession } from './interaction-touch-fixtures.ts';

test('a plain ref emitted by the current partial frame suggests its exact pinned form', () => {
  const session = makeStaleRefSession('partial-frame-suggestion');
  session.snapshotGeneration = 531_735;
  activatePartialRefFrame(session, new Set(['e19', 'e20']));

  const response = refMutationAdmissionResponse({
    session,
    ref: '@e19',
    mintedGeneration: undefined,
    staleRefsWarning: undefined,
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.details).toMatchObject({
      reason: 'plain_ref_requires_complete_frame',
      suggestedRef: '@e19~s531735',
      hint: 'Retry with the exact emitted ref @e19~s531735.',
    });
  }
});

test('a plain ref outside the emitted partial scope keeps the recapture hint', () => {
  const session = makeStaleRefSession('partial-frame-no-suggestion');
  session.snapshotGeneration = 531_735;
  activatePartialRefFrame(session, new Set(['e20']));

  const response = refMutationAdmissionResponse({
    session,
    ref: '@e19',
    mintedGeneration: undefined,
    staleRefsWarning: undefined,
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.details?.suggestedRef).toBeUndefined();
    expect(response.error.details?.hint).toBe(
      'Capture a fresh interactive snapshot (snapshot -i) or use a stable selector, then retry.',
    );
  }
});
