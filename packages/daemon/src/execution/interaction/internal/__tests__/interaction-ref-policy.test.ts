import { expect, test } from 'vitest';
import { activatePartialRefFrame, readRefMutationFrame } from '../../../../core/ref-frame.ts';
import { refMutationAdmissionResponse } from '../interaction-ref-policy.ts';
import { makeStaleRefSession } from './interaction-touch-fixtures.ts';

test('a plain ref emitted by the current partial frame suggests its exact pinned form', () => {
  const session = makeStaleRefSession('partial-frame-suggestion');
  session.snapshotGeneration = 531_735;
  activatePartialRefFrame(session, new Set(['e19', 'e20']));

  const response = refMutationAdmissionResponse({
    ref: '@e19',
    mintedGeneration: undefined,
    staleRefsWarning: undefined,
    frame: readRefMutationFrame({ session, ref: '@e19', mintedGeneration: undefined }),
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.details).toMatchObject({
      reason: 'plain_ref_requires_complete_frame',
      suggestedRef: '@e19-s531735',
      hint: 'Retry with the exact emitted ref @e19-s531735.',
    });
  }
});

test('a plain ref outside the emitted partial scope keeps the recapture hint', () => {
  const session = makeStaleRefSession('partial-frame-no-suggestion');
  session.snapshotGeneration = 531_735;
  activatePartialRefFrame(session, new Set(['e20']));

  const response = refMutationAdmissionResponse({
    ref: '@e19',
    mintedGeneration: undefined,
    staleRefsWarning: undefined,
    frame: readRefMutationFrame({ session, ref: '@e19', mintedGeneration: undefined }),
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.message).toBe(
      'Ref @e19 needs a complete snapshot — the current frame only authorizes its emitted refs',
    );
    expect(response.error.details?.suggestedRef).toBeUndefined();
    expect(response.error.details?.replacedBy).toBeUndefined();
    expect(response.error.details?.replacementRefs).toBeUndefined();
    expect(response.error.details?.hint).toBe(
      'Capture a fresh interactive snapshot (snapshot -i) or use a stable selector, then retry.',
    );
  }
});

// #4571: `fill @e3 … --settle; press @e4` with @e4 from the earlier full snapshot — the
// settle diff replaced the frame, so the refusal names it and hands back what it issued
// instead of leaving the caller a full `snapshot -i` round trip.
test('a settled-diff frame names the diff as the replacement and lists its issued refs pinned', () => {
  const session = makeStaleRefSession('settle-frame-replacement');
  session.snapshotGeneration = 531_735;
  activatePartialRefFrame(session, new Set(['e34', 'e7']), 'settle-diff');

  const response = refMutationAdmissionResponse({
    ref: '@e4',
    mintedGeneration: undefined,
    staleRefsWarning: undefined,
    frame: readRefMutationFrame({ session, ref: '@e4', mintedGeneration: undefined }),
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.message).toBe(
      'Ref @e4 needs a complete snapshot — a settled diff replaced the ref frame and only authorizes its issued refs',
    );
    expect(response.error.details).toMatchObject({
      reason: 'plain_ref_requires_complete_frame',
      currentGeneration: 531_735,
      replacedBy: 'settle-diff',
      replacementRefs: ['@e34-s531735', '@e7-s531735'],
      hint: 'Retry with one of the refs the settled diff issued: @e34-s531735, @e7-s531735 — or capture a fresh interactive snapshot (snapshot -i).',
    });
  }
});

test('a settled-diff frame keeps the exact-emitted suggestion when the refused body is one it issued', () => {
  const session = makeStaleRefSession('settle-frame-emitted');
  session.snapshotGeneration = 531_735;
  activatePartialRefFrame(session, new Set(['e34']), 'settle-diff');

  const response = refMutationAdmissionResponse({
    ref: '@e34',
    mintedGeneration: undefined,
    staleRefsWarning: undefined,
    frame: readRefMutationFrame({ session, ref: '@e34', mintedGeneration: undefined }),
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.details).toMatchObject({
      suggestedRef: '@e34-s531735',
      hint: 'Retry with the exact emitted ref @e34-s531735.',
    });
    expect(response.error.details?.replacementRefs).toBeUndefined();
  }
});

test('a settled-diff frame that issued no refs keeps the recapture guidance', () => {
  const session = makeStaleRefSession('settle-frame-empty');
  session.snapshotGeneration = 531_735;
  activatePartialRefFrame(session, new Set(), 'settle-diff');

  const response = refMutationAdmissionResponse({
    ref: '@e19',
    mintedGeneration: undefined,
    staleRefsWarning: undefined,
    frame: readRefMutationFrame({ session, ref: '@e19', mintedGeneration: undefined }),
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.message).toBe(
      'Ref @e19 needs a complete snapshot — a settled diff replaced the ref frame and issued no refs',
    );
    expect(response.error.details).toMatchObject({
      reason: 'plain_ref_requires_complete_frame',
      replacedBy: 'settle-diff',
    });
    expect(response.error.details?.replacementRefs).toBeUndefined();
    expect(response.error.details?.hint).toBe(
      'Capture a fresh interactive snapshot (snapshot -i) or use a stable selector, then retry.',
    );
  }
});
