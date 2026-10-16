import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { makeIosSession } from '../../../__tests__/support/session-factories.ts';
import { SessionStore } from '../../../core/session-store.ts';
import { buildReplayFailureDivergence } from '@agent-device/replay-port/session-replay-divergence';
import { replayDivergenceForTest } from './replay-session-fixture.ts';
import {
  legacyDispatchCapture,
  resetLegacySnapshotCapture,
} from '../../../__tests__/support/legacy-snapshot-capture-fixture.ts';
import { captureSnapshotWithInteractor } from '../../../core/snapshot-interactor-capture.ts';

vi.mock('@agent-device/device-selection/dispatch-resolve', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/device-selection/dispatch-resolve')>();
  return { ...actual, resolveTargetDevice: vi.fn() };
});
vi.mock('../../../core/snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));

const mockDispatchCommand = legacyDispatchCapture;
beforeEach(() => resetLegacySnapshotCapture(vi.mocked(captureSnapshotWithInteractor)));

test('buildReplayFailureDivergence dedupes suggestions using the strongest basis', async () => {
  const root = mkdtempForTestSync('agent-device-replay-suggest-dedupe-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.publish(
    sessionName,
    makeIosSession(sessionName, { appBundleId: 'com.example.app' }),
  );

  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        label: 'Save',
        identifier: 'save',
        rect: { x: 0, y: 0, width: 100, height: 44 },
        hittable: true,
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const action = {
    ts: 0,
    command: 'click',
    positionals: ['label="Save"'],
    flags: {},
    result: { selectorChain: ['label="Save"', 'id="save"'] },
  };
  const divergence = await buildReplayFailureDivergence({
    error: { code: 'COMMAND_FAILED', message: 'not hittable' },
    action,
    index: 0,
    sourcePath: path.join(root, 'flow.ad'),
    sourceLine: 1,
    ...replayDivergenceForTest(sessionStore, sessionName),
    logPath: path.join(root, 'daemon.log'),
    responseLevel: 'default',
    planActions: [action],
    planDigest: 'test-plan-digest',
  });

  expect(divergence.suggestionCount).toBe(1);
  expect(divergence.suggestions).toHaveLength(1);
  expect(divergence.suggestions[0]?.ref).toBe('e1');
  expect(divergence.suggestions[0]?.basis).toBe('id');
});

test.each(['region', 'absent', 'none', 'unverifiable'] as const)(
  'suggestions rank identity, recorded region, then document order (evidence: %s)',
  async (evidence) => {
    const root = mkdtempForTestSync('agent-device-replay-suggest-region-');
    const sessionStore = new SessionStore(path.join(root, 'sessions'));
    sessionStore.publish('default', makeIosSession('default', { appBundleId: 'com.example.app' }));
    const button = (index: number, parentIndex: number, label: string) => ({
      index,
      parentIndex,
      depth: 1,
      type: 'Button',
      label,
      rect: { x: 0, y: index * 10, width: 100, height: 44 },
      hittable: true,
    });
    mockDispatchCommand.mockResolvedValue({
      nodes: [
        { index: 0, depth: 0, type: 'ScrollView', identifier: 'other' },
        button(1, 0, 'Other'),
        { ...button(2, 0, 'Strong'), identifier: 'strong' },
        { index: 3, depth: 0, type: 'ScrollView', identifier: 'recorded' },
        button(4, 3, 'First'),
        button(5, 3, 'Second'),
        { ...button(6, 0, 'Outside'), parentIndex: undefined, depth: 0 },
      ],
      truncated: false,
      backend: 'xctest',
    });
    const action = {
      ts: 0,
      command: 'click',
      positionals: ['label="Other"'],
      flags: {},
      result: {
        selectorChain: ['label="Second"', 'label="First"', 'id="strong"', 'label="Outside"'],
      },
      ...(evidence !== 'absent'
        ? {
            targetEvidence: {
              role: 'button',
              label: 'Original',
              ancestry: [],
              sibling: 0,
              viewportOrder: 0,
              ...(evidence === 'region'
                ? { scrollRegion: { role: 'scrollview', id: 'recorded' } }
                : {}),
              verification:
                evidence === 'unverifiable' ? ('unverifiable' as const) : ('verified' as const),
            },
          }
        : {}),
    };
    const divergence = await buildReplayFailureDivergence({
      error: { code: 'COMMAND_FAILED', message: 'not hittable' },
      action,
      index: 0,
      sourcePath: path.join(root, 'flow.ad'),
      sourceLine: 1,
      ...replayDivergenceForTest(sessionStore, 'default'),
      logPath: path.join(root, 'daemon.log'),
      responseLevel: 'full',
      planActions: [action],
      planDigest: 'test-plan-digest',
    });
    expect(divergence.suggestions.map(({ label }) => label)).toEqual(
      evidence === 'region'
        ? ['Strong', 'First', 'Second', 'Other', 'Outside']
        : evidence === 'none'
          ? ['Strong', 'Outside', 'Other', 'First', 'Second']
          : ['Strong', 'Other', 'First', 'Second', 'Outside'],
    );
  },
);
