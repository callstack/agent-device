import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { bindInternalObservationAuthority } from '../internal-observation.ts';
import { expireRefFrame } from '../ref-frame.ts';
import { markSessionPartialRefsIssued, setSessionSnapshot } from '../session-snapshot.ts';
import { SessionStore } from '../session-store.ts';

function snapshot(ref: string, label = ref): SnapshotState {
  return {
    createdAt: Date.now(),
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        ref,
        label,
        rect: { x: 0, y: 0, width: 100, height: 44 },
        hittable: true,
      },
    ],
  };
}

function scenario() {
  const root = path.join(os.tmpdir(), `agent-device-internal-observation-${crypto.randomUUID()}`);
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  const session = makeIosSession(sessionName, { appBundleId: 'com.example.app' });
  const prior = snapshot('e1', 'Previously published');
  setSessionSnapshot(session, prior);
  markSessionPartialRefsIssued(session, ['e1']);
  sessionStore.set(sessionName, session);
  const captured = snapshot('e2', 'Internal capture');
  const authority = bindAuthority(sessionStore, sessionName);
  const stored = authority.store(captured);
  return { sessionStore, sessionName, session, prior, captured, authority, ...stored };
}

function publishCurrent(input: ReturnType<typeof scenario>, signal?: AbortSignal) {
  const authority = bindAuthority(input.sessionStore, input.sessionName, signal);
  return authority.finalize(input.evidence, {
    refsGeneration: input.refsGeneration,
    refs: ['@e2'],
  });
}

function bindAuthority(sessionStore: SessionStore, sessionName: string, signal?: AbortSignal) {
  return bindInternalObservationAuthority({
    sessionStore: {
      get: () => sessionStore.get(sessionName),
      update: (mutate) => {
        const session = sessionStore.get(sessionName);
        if (!session) return false;
        mutate(session);
        sessionStore.set(sessionName, session);
        return true;
      },
    },
    sessionName,
    ...(signal ? { signal } : {}),
  });
}

test('publishes exactly the validated outward refs from a current internal capture', () => {
  const input = scenario();

  expect(publishCurrent(input)).toEqual({
    published: true,
    refsGeneration: input.refsGeneration,
    refCount: 1,
  });
  expect(input.session.refFrameState).toBe('active');
  expect(input.session.refFrameScope).toEqual(new Set(['e2']));
  expect(input.session.refFrameTree).toBe(input.captured);
  expect(input.session.refFrameGeneration).toBe(input.refsGeneration);
  expect(publishCurrent(input)).toEqual({ published: false, reason: 'stale-capture' });
});

test('empty publication never supersedes prior client authority', () => {
  const input = scenario();

  const result = input.authority.finalize(input.evidence, {
    refsGeneration: input.refsGeneration,
    refs: [],
  });

  expect(result).toEqual({ published: false, reason: 'empty' });
  expect(input.session.refFrameScope).toEqual(new Set(['e1']));
  expect(input.session.refFrameTree).toBe(input.prior);
});

test('an empty finalization consumes its evidence and cannot later publish', () => {
  const input = scenario();

  const first = input.authority.finalize(input.evidence, {
    refsGeneration: input.refsGeneration,
    refs: [],
  });

  expect(first).toEqual({ published: false, reason: 'empty' });
  expect(publishCurrent(input)).toEqual({ published: false, reason: 'stale-capture' });
  expect(input.session.refFrameScope).toEqual(new Set(['e1']));
});

test('cancelled publication leaves prior client authority intact', () => {
  const input = scenario();
  const controller = new AbortController();
  controller.abort();

  expect(publishCurrent(input, controller.signal)).toEqual({
    published: false,
    reason: 'cancelled',
  });
  expect(publishCurrent(input)).toEqual({ published: false, reason: 'stale-capture' });
  expect(input.session.refFrameScope).toEqual(new Set(['e1']));
  expect(input.session.refFrameTree).toBe(input.prior);
});

test('a newer capture makes older capture evidence stale', () => {
  const input = scenario();
  setSessionSnapshot(input.session, snapshot('e3', 'Later capture'));

  expect(publishCurrent(input)).toEqual({ published: false, reason: 'stale-capture' });
  expect(input.session.refFrameScope).toEqual(new Set(['e1']));
});

test('a later ref publication prevents an older capture from superseding it', () => {
  const input = scenario();
  markSessionPartialRefsIssued(input.session, ['e2']);
  const laterTree = input.session.refFrameTree;

  expect(publishCurrent(input)).toEqual({ published: false, reason: 'stale-capture' });
  expect(input.session.refFrameTree).toBe(laterTree);
});

test('a runtime side effect invalidates capture evidence without rolling authority back', () => {
  const input = scenario();
  expireRefFrame(input.session);

  expect(publishCurrent(input)).toEqual({ published: false, reason: 'stale-capture' });
  expect(input.session.refFrameState).toBe('expired');
  expect(input.session.refFrameTree).toBe(input.prior);
});

test('runtime revision invalidates evidence even when the ref frame was already expired', () => {
  const input = scenario();
  expireRefFrame(input.session);
  const recaptured = input.authority.store(snapshot('e3', 'Captured after expiry'));
  expireRefFrame(input.session);

  const result = input.authority.finalize(recaptured.evidence, {
    refsGeneration: recaptured.refsGeneration,
    refs: ['e3'],
  });

  expect(result).toEqual({ published: false, reason: 'stale-capture' });
  expect(input.session.refFrameState).toBe('expired');
  expect(input.session.refFrameTree).toBe(input.prior);
});

test('session close invalidates capture evidence', () => {
  const input = scenario();
  input.sessionStore.delete(input.sessionName);

  expect(publishCurrent(input)).toEqual({ published: false, reason: 'stale-capture' });
  // Even restoring the exact same session object cannot revive evidence that
  // a stale finalization attempt already consumed.
  input.sessionStore.set(input.sessionName, input.session);
  expect(publishCurrent(input)).toEqual({ published: false, reason: 'stale-capture' });
  expect(input.session.refFrameScope).toEqual(new Set(['e1']));
});

test('same-name session replacement cannot inherit capture evidence', () => {
  const input = scenario();
  const replacement = makeIosSession(input.sessionName, { appBundleId: 'com.example.app' });
  input.sessionStore.set(input.sessionName, replacement);

  expect(publishCurrent(input)).toEqual({ published: false, reason: 'stale-capture' });
  expect(replacement.refFrameTree).toBeUndefined();
});

test('generation and ref projection must match the exact captured tree', () => {
  const wrongGeneration = scenario();
  const generationResult = wrongGeneration.authority.finalize(wrongGeneration.evidence, {
    refsGeneration: wrongGeneration.refsGeneration + 1,
    refs: ['e2'],
  });
  expect(generationResult).toEqual({ published: false, reason: 'invalid-projection' });
  expect(publishCurrent(wrongGeneration)).toEqual({
    published: false,
    reason: 'stale-capture',
  });

  const wrongRef = scenario();
  const refResult = wrongRef.authority.finalize(wrongRef.evidence, {
    refsGeneration: wrongRef.refsGeneration,
    refs: ['e999'],
  });
  expect(refResult).toEqual({ published: false, reason: 'invalid-projection' });
  expect(publishCurrent(wrongRef)).toEqual({ published: false, reason: 'stale-capture' });
  expect(wrongGeneration.session.refFrameScope).toEqual(new Set(['e1']));
  expect(wrongRef.session.refFrameScope).toEqual(new Set(['e1']));
});
