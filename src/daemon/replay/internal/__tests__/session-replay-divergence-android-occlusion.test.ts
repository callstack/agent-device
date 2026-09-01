import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { makeAndroidSession } from '../../../../__tests__/test-utils/session-factories.ts';
import {
  ANDROID_QS_SHADE_CAPTURE_RAW_NODES,
  walkNonRawAndroidFixture,
} from '../../../../__tests__/test-utils/android-ui-hierarchy-fixtures.ts';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';
import { SessionStore } from '../../../session-store.ts';
import { replayCoordinatorForTest, replaySessionForTest } from './replay-session-fixture.ts';
import {
  captureSnapshotThroughLegacyDispatchFixture,
  legacyDispatchCapture,
} from '../../../__tests__/legacy-snapshot-capture-fixture.ts';
import { buildReplayFailureDivergence } from '../session-replay-divergence.ts';
import { captureSnapshotWithInteractor } from '../../../handlers/snapshot-interactor-capture.ts';

vi.mock('../../../../core/dispatch-resolve.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../core/dispatch-resolve.ts')>();
  return { ...actual, resolveTargetDevice: vi.fn() };
});
vi.mock('../../../handlers/snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));

const mockDispatchCommand = legacyDispatchCapture;
const mockCaptureSnapshotWithInteractor = vi.mocked(captureSnapshotWithInteractor);

beforeEach(() => {
  mockDispatchCommand.mockReset();
  mockDispatchCommand.mockResolvedValue({});
  mockCaptureSnapshotWithInteractor.mockReset();
  mockCaptureSnapshotWithInteractor.mockImplementation(captureSnapshotThroughLegacyDispatchFixture);
});

// Real walked FULL-COVER quick-settings shade: every node is systemui and the status-bar icons
// share the shade's window. The second scenario models older/OEM trees that mark the whole surface
// as chrome; replay repair must remain actionable without promoting non-hittable status residue.
test.each([
  {
    name: 'classifies the shade precisely',
    prepare: (nodes: RawSnapshotNode[]) => nodes,
  },
  {
    name: 'survives a whole-tree chrome false positive',
    prepare: (nodes: RawSnapshotNode[]) =>
      nodes.map((node) => ({ ...node, systemChrome: true as const })),
  },
])('buildReplayFailureDivergence: a full-cover quick-settings shade $name', async ({ prepare }) => {
  const root = mkdtempForTestSync('agent-device-replay-divergence-qsshade-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(
    sessionName,
    makeAndroidSession(sessionName, { appBundleId: 'com.google.android.deskclock' }),
  );

  const walked = prepare(walkNonRawAndroidFixture(ANDROID_QS_SHADE_CAPTURE_RAW_NODES));
  mockDispatchCommand.mockResolvedValue({ nodes: walked, truncated: false, backend: 'android' });

  const action = {
    ts: 0,
    command: 'get',
    positionals: ['text', 'label="World Clock"'],
    flags: {},
    result: { selectorChain: ['label="World Clock"'] },
  };
  const divergence = await buildReplayFailureDivergence({
    error: { code: 'COMMAND_FAILED', message: 'Selector did not match: label="World Clock"' },
    action,
    index: 0,
    sourcePath: path.join(root, 'flow.ad'),
    sourceLine: 1,
    session: replaySessionForTest(sessionStore, sessionName).observationStore.get(),
    sessionName,
    sessionStore: replaySessionForTest(sessionStore, sessionName).store,
    observationStore: replaySessionForTest(sessionStore, sessionName).observationStore,
    resumeStamper: replayCoordinatorForTest(sessionStore, sessionName).resumeStamper,
    logPath: path.join(root, 'daemon.log'),
    responseLevel: 'default',
    planActions: [action],
    planDigest: 'test-plan-digest',
  });

  expect(divergence.screen.state).toBe('available');
  const screen = divergence.screen as Extract<typeof divergence.screen, { state: 'available' }>;

  expect(walked.some((node) => node.hittable === true)).toBe(true);
  expect(screen.refs.some((ref) => ref.label === 'Display brightness')).toBe(true);
  expect(screen.refs.length).toBe(20);
  // This synthetic result has no private sibling order, so publication fails conservative and
  // discloses that more actionable refs exist beyond the response limit.
  expect(screen.truncated).toBe(true);

  const published = new Map(
    (sessionStore.get(sessionName)?.snapshot?.nodes ?? []).map((node) => [node.ref, node]),
  );
  expect(screen.refs.every((ref) => published.get(ref.ref)?.hittable === true)).toBe(true);
  expect(screen.refs.some((ref) => ref.label === 'Battery charging, 100 percent.')).toBe(false);
  expect(screen.refs.some((ref) => ref.label === 'Wifi signal full.')).toBe(false);
});
