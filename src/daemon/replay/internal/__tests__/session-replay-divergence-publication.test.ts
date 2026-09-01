import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';

vi.mock('../../../handlers/snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));

import { captureSnapshotWithInteractor } from '../../../handlers/snapshot-interactor-capture.ts';
import { makeIosSession } from '../../../../__tests__/test-utils/session-factories.ts';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import type { ReplayDivergence } from '@agent-device/contracts/divergence';
import { bindInternalObservationAuthority } from '../../../internal-observation.ts';
import { expireRefFrame } from '../../../ref-frame.ts';
import { markSessionPartialRefsIssued, setSessionSnapshot } from '../../../session-snapshot.ts';
import { SessionStore } from '../../../session-store.ts';
import { captureDivergenceObservation } from '../session-replay-divergence.ts';
import { boundReplayDivergenceForSession } from '../session-replay-divergence-publication.ts';
import { replaySessionForTest } from './replay-session-fixture.ts';
import {
  captureSnapshotThroughLegacyDispatchFixture,
  legacyDispatchCapture,
} from '../../../__tests__/legacy-snapshot-capture-fixture.ts';

const mockDispatchCommand = legacyDispatchCapture;
const mockCaptureSnapshotWithInteractor = vi.mocked(captureSnapshotWithInteractor);

beforeEach(() => {
  mockDispatchCommand.mockReset();
  mockDispatchCommand.mockResolvedValue({});
  mockCaptureSnapshotWithInteractor.mockReset();
  mockCaptureSnapshotWithInteractor.mockImplementation(captureSnapshotThroughLegacyDispatchFixture);
});

function scenario(refCount = 20) {
  const root = mkdtempForTestSync('agent-device-divergence-publication-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  const session = makeIosSession(sessionName, { appBundleId: 'com.example.app' });
  const prior: SnapshotState = {
    createdAt: 1,
    nodes: [{ index: 0, depth: 0, type: 'Button', ref: 'old', label: 'Old' }],
  };
  setSessionSnapshot(session, prior);
  markSessionPartialRefsIssued(session, ['old']);
  sessionStore.set(sessionName, session);
  const replaySession = replaySessionForTest(sessionStore, sessionName);
  const snapshot: SnapshotState = {
    createdAt: 2,
    nodes: Array.from({ length: refCount }, (_, index) => ({
      index,
      depth: 0,
      type: 'Button',
      ref: `e${index + 1}`,
      label: `Button ${index + 1}`,
      rect: { x: 0, y: index * 44, width: 100, height: 44 },
      hittable: true,
    })),
  };
  const authority = bindInternalObservationAuthority({
    sessionStore: replaySession.observationStore,
    sessionName,
  });
  const observation = authority.store(snapshot);
  return {
    root,
    sessionStore,
    replaySession,
    sessionName,
    session,
    prior,
    snapshot,
    ...observation,
  };
}

function divergence(
  input: ReturnType<typeof scenario>,
  overrides: Partial<ReplayDivergence> = {},
): ReplayDivergence {
  return {
    version: 1,
    kind: 'action-failure',
    step: { index: 1, source: { path: '/tmp/flow.ad', line: 1 } },
    action: 'press label="Save"',
    cause: { code: 'COMMAND_FAILED', message: 'failed' },
    screen: {
      state: 'available',
      refsGeneration: input.refsGeneration,
      refs: input.snapshot.nodes.map((node) => ({
        ref: node.ref!,
        role: 'button',
        label: node.label,
      })),
    },
    suggestions: [],
    suggestionCount: 0,
    resume: { allowed: false, from: 1, planDigest: 'digest', reason: 'failed' },
    repairHint: 'manual',
    ...overrides,
  };
}

test('internal divergence capture updates observation without publishing client ref authority', async () => {
  const input = scenario(1);
  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        label: 'Captured again',
        rect: { x: 0, y: 50, width: 100, height: 44 },
        hittable: true,
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const observation = await captureDivergenceObservation({
    session: input.session,
    sessionName: input.sessionName,
    observationStore: input.replaySession.observationStore,
    logPath: path.join(input.root, 'daemon.log'),
    action: {
      command: 'press',
      positionals: ['label="Captured again"'],
      flags: {},
      result: {},
    },
  });

  expect(observation.state).toBe('available');
  expect(input.session.snapshot?.nodes[0]?.label).toBe('Captured again');
  expect(input.session.refFrameScope).toEqual(new Set(['old']));
  expect(input.session.refFrameTree).toBe(input.prior);
});

test.each([
  ['digest', 8],
  ['default', 20],
  ['full', 20],
] as const)('publishes exactly the direct %s response-level ref cap', (level, expected) => {
  const input = scenario();

  const result = boundReplayDivergenceForSession({
    sessionStore: input.replaySession.store,
    observationStore: input.replaySession.observationStore,
    sessionName: input.sessionName,
    divergence: divergence(input),
    responseLevel: level,
    evidence: input.evidence,
  });

  expect(result.screen.state).toBe('available');
  const refs =
    result.screen.state === 'available' ? result.screen.refs.map((entry) => entry.ref) : [];
  expect(refs).toHaveLength(expected);
  expect(input.session.refFrameScope).toEqual(new Set(refs));
  expect(input.session.refFrameTree).toBe(input.snapshot);
});

test('missing capture evidence fails closed instead of exposing unauthorized refs', () => {
  const input = scenario();

  const result = boundReplayDivergenceForSession({
    sessionStore: input.replaySession.store,
    observationStore: input.replaySession.observationStore,
    sessionName: input.sessionName,
    divergence: divergence(input),
    responseLevel: 'default',
    evidence: undefined,
  });

  expect(result.screen).toEqual(
    expect.objectContaining({
      state: 'unavailable',
      reason: 'ref-publication-missing-evidence',
    }),
  );
  expect(input.session.refFrameScope).toEqual(new Set(['old']));
  expect(input.session.refFrameTree).toBe(input.prior);
});

test('degenerate projected refs fail closed when publication normalizes to empty', () => {
  const input = scenario();
  const result = boundReplayDivergenceForSession({
    sessionStore: input.replaySession.store,
    observationStore: input.replaySession.observationStore,
    sessionName: input.sessionName,
    divergence: divergence(input, {
      screen: {
        state: 'available',
        refsGeneration: input.refsGeneration,
        refs: [
          { ref: '@', role: 'button', label: 'Empty ref' },
          { ref: '@~s3', role: 'button', label: 'Empty scoped ref' },
        ],
      },
      suggestions: [
        { selector: 'label="Empty ref"', basis: 'label', ref: '@' },
        { selector: 'label="Empty scoped ref"', basis: 'label', ref: '@~s3' },
      ],
      suggestionCount: 2,
    }),
    responseLevel: 'default',
    evidence: input.evidence,
  });

  expect(result.screen).toEqual(
    expect.objectContaining({
      state: 'unavailable',
      reason: 'ref-publication-empty',
    }),
  );
  expect(result.suggestions).toEqual([
    { selector: 'label="Empty ref"', basis: 'label' },
    { selector: 'label="Empty scoped ref"', basis: 'label' },
  ]);
  expect(input.session.refFrameScope).toEqual(new Set(['old']));
  expect(input.session.refFrameTree).toBe(input.prior);
});

test('an empty outward projection consumes its one-shot capture evidence', () => {
  const input = scenario();
  const empty = divergence(input, {
    screen: {
      state: 'available',
      refsGeneration: input.refsGeneration,
      refs: [],
    },
  });

  const first = boundReplayDivergenceForSession({
    sessionStore: input.replaySession.store,
    observationStore: input.replaySession.observationStore,
    sessionName: input.sessionName,
    divergence: empty,
    responseLevel: 'default',
    evidence: input.evidence,
  });
  const second = boundReplayDivergenceForSession({
    sessionStore: input.replaySession.store,
    observationStore: input.replaySession.observationStore,
    sessionName: input.sessionName,
    divergence: divergence(input),
    responseLevel: 'default',
    evidence: input.evidence,
  });

  expect(first.screen).toEqual(empty.screen);
  expect(second.screen).toEqual(
    expect.objectContaining({
      state: 'unavailable',
      reason: 'ref-publication-stale-capture',
    }),
  );
  expect(input.session.refFrameScope).toEqual(new Set(['old']));
  expect(input.session.refFrameTree).toBe(input.prior);
});

test('successful overflow publishes the refs exposed by the exact artifact projection', () => {
  const input = scenario();
  const result = boundReplayDivergenceForSession({
    sessionStore: input.replaySession.store,
    observationStore: input.replaySession.observationStore,
    sessionName: input.sessionName,
    divergence: divergence(input, {
      cause: { code: 'COMMAND_FAILED', message: 'x'.repeat(40_000) },
    }),
    responseLevel: 'default',
    evidence: input.evidence,
  });

  expect(result.screen.state).toBe('unavailable');
  expect(result.overflow?.artifactPath).toBeTruthy();
  const artifact = JSON.parse(fs.readFileSync(result.overflow!.artifactPath, 'utf8')) as {
    screen: { refs: Array<{ ref: string }> };
  };
  const artifactRefs = artifact.screen.refs.map((entry) => entry.ref);
  expect(input.session.refFrameScope).toEqual(new Set(artifactRefs));
  expect(input.session.refFrameTree).toBe(input.snapshot);
});

test('failed overflow artifact with no inline refs publishes nothing', () => {
  const input = scenario();
  const blockedArtifactDir = path.join(
    input.sessionStore.ensureSessionDir(input.sessionName),
    'replay-divergence',
  );
  fs.writeFileSync(blockedArtifactDir, 'not a directory');

  const result = boundReplayDivergenceForSession({
    sessionStore: input.replaySession.store,
    observationStore: input.replaySession.observationStore,
    sessionName: input.sessionName,
    divergence: divergence(input, {
      cause: { code: 'COMMAND_FAILED', message: 'x'.repeat(40_000) },
    }),
    responseLevel: 'default',
    evidence: input.evidence,
  });

  expect(result.artifactUnavailable).toBe(true);
  expect(result.screen.state).toBe('unavailable');
  expect(input.session.refFrameScope).toEqual(new Set(['old']));
  expect(input.session.refFrameTree).toBe(input.prior);
});

test('stale capture suppresses outward refs and preserves newer authority', () => {
  const input = scenario();
  setSessionSnapshot(input.session, {
    createdAt: 3,
    nodes: [{ index: 0, depth: 0, type: 'Button', ref: 'newer', label: 'Newer' }],
  });

  const result = boundReplayDivergenceForSession({
    sessionStore: input.replaySession.store,
    observationStore: input.replaySession.observationStore,
    sessionName: input.sessionName,
    divergence: divergence(input),
    responseLevel: 'default',
    evidence: input.evidence,
  });

  expect(result.screen.state).toBe('unavailable');
  expect(input.session.refFrameScope).toEqual(new Set(['old']));
});

test('cancellation after capture suppresses outward refs without reactivating an expired frame', () => {
  const input = scenario();
  expireRefFrame(input.session);
  const controller = new AbortController();
  controller.abort();

  const result = boundReplayDivergenceForSession({
    sessionStore: input.replaySession.store,
    observationStore: input.replaySession.observationStore,
    sessionName: input.sessionName,
    divergence: divergence(input),
    responseLevel: 'default',
    evidence: input.evidence,
    signal: controller.signal,
  });

  expect(result.screen.state).toBe('unavailable');
  expect(input.session.refFrameState).toBe('expired');
  expect(input.session.refFrameTree).toBe(input.prior);
});
