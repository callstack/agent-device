import { expect, test } from 'vitest';
import type { SnapshotState } from '../../kernel/snapshot.ts';
import type { SessionState } from '../types.ts';
import {
  resolveRefStalenessWarning,
  setSessionSnapshot,
  STALE_SNAPSHOT_REFS_WARNING,
} from '../session-snapshot.ts';

function makeSession(): SessionState {
  return {
    name: 'default',
    device: { id: 'device-1', name: 'Test Device', platform: 'apple' },
    createdAt: Date.now(),
    actions: [],
  } as unknown as SessionState;
}

function makeSnapshot(): SnapshotState {
  return { nodes: [], createdAt: Date.now(), backend: 'xctest' };
}

test('setSessionSnapshot advances the generation on every tree replacement (#1076 versioned refs)', () => {
  const session = makeSession();
  expect(session.snapshotGeneration).toBeUndefined();

  const first = makeSnapshot();
  setSessionSnapshot(session, first);
  expect(session.snapshotGeneration).toBe(1);
  expect(session.snapshotRefsStale).toBe(true);

  // Storing the SAME snapshot object again is not a replacement.
  setSessionSnapshot(session, first);
  expect(session.snapshotGeneration).toBe(1);

  setSessionSnapshot(session, makeSnapshot());
  expect(session.snapshotGeneration).toBe(2);
});

test('resolveRefStalenessWarning: pinned-current clean, pinned-stale precise, plain coarse', () => {
  const session = makeSession();
  session.snapshotGeneration = 15;
  session.snapshotRefsStale = true;

  // Pinned to the stored generation: the pin proves the ref matches the tree,
  // so the coarse marker is overruled.
  expect(
    resolveRefStalenessWarning({ session, ref: '@e37', mintedGeneration: 15 }),
  ).toBeUndefined();

  expect(resolveRefStalenessWarning({ session, ref: '@e37', mintedGeneration: 12 })).toBe(
    'Ref @e37 was minted from snapshot s12 but the session tree is now s15 — re-run snapshot -i.',
  );

  expect(resolveRefStalenessWarning({ session, ref: '@e37', mintedGeneration: undefined })).toBe(
    STALE_SNAPSHOT_REFS_WARNING,
  );

  session.snapshotRefsStale = false;
  expect(
    resolveRefStalenessWarning({ session, ref: '@e37', mintedGeneration: undefined }),
  ).toBeUndefined();
});

test('resolveRefStalenessWarning treats a missing stored generation as s0', () => {
  const session = makeSession();
  expect(resolveRefStalenessWarning({ session, ref: 'e2', mintedGeneration: 3 })).toBe(
    'Ref @e2 was minted from snapshot s3 but the session tree is now s0 — re-run snapshot -i.',
  );
  expect(resolveRefStalenessWarning({ session, ref: '@e2', mintedGeneration: 0 })).toBeUndefined();
});
