import { test, expect, vi, afterEach, beforeEach } from 'vitest';
import { legacyDispatchCapture } from '../../__tests__/legacy-snapshot-capture-fixture.ts';
import { resetGetRuntimeFixture } from '../../__tests__/interaction-get-runtime-fixture.ts';
import { captureSnapshot } from '../../snapshot-capture.ts';
import {
  isActiveProviderDevice,
  setActiveProviderDeviceRuntimes,
} from '../../../provider-device-runtime.ts';
import { installProviderDeviceAdmission } from '../../provider-device-admission.ts';

// The daemon reads provider ownership through its own typed admission seam; production
// installs it from root composition, and these tests compose it the same way.
installProviderDeviceAdmission({ isActive: isActiveProviderDevice });
import { buildNodes } from '../../../__tests__/test-utils/snapshot-builders.ts';
import { resetSnapshotRuntimeFixture } from '../../__tests__/snapshot-runtime-fixture.ts';
import {
  androidCapture,
  androidDevice,
  androidTextRows,
  inboxBaselineNodes,
  makeAndroidFreshnessSession,
} from './snapshot-handler.fixtures.ts';

vi.mock('../../snapshot-interactor-capture.ts', async () => {
  const fixture = await import('../../__tests__/legacy-snapshot-capture-fixture.ts');
  return { captureSnapshotWithInteractor: fixture.captureSnapshotThroughLegacyDispatchFixture };
});
vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>();
  return { ...actual, runAppleRunnerCommand: vi.fn(async () => ({})) };
});

// The real implementation shells out to simctl to probe for a hint-worthy
// unambiguous environment; that live-probe logic is covered by
// ios-app-session-hint.test.ts. Stubbed here so this suite stays hermetic and
// fast — defaults to "no enrichment", matching the current-behavior fallback.
vi.mock('../../ios-app-session-hint.ts', () => ({
  buildIosOpenCommandHint: vi.fn(async () => undefined),
}));

import { runAppleRunnerCommand } from '@agent-device/platform-apple/runner/operations';
import { buildIosOpenCommandHint } from '../../ios-app-session-hint.ts';

const mockRunnerCommand = vi.mocked(runAppleRunnerCommand);
const mockBuildIosOpenCommandHint = vi.mocked(buildIosOpenCommandHint);

afterEach(() => {
  setActiveProviderDeviceRuntimes([]);
});

beforeEach(() => {
  resetSnapshotRuntimeFixture();
  legacyDispatchCapture.mockReset();
  legacyDispatchCapture.mockResolvedValue({});
  resetGetRuntimeFixture();
  mockRunnerCommand.mockReset();
  mockRunnerCommand.mockResolvedValue({});
  mockBuildIosOpenCommandHint.mockReset();
  mockBuildIosOpenCommandHint.mockResolvedValue(undefined);
});

test('captureSnapshot composes post-gesture stabilization with Android freshness capture', async () => {
  const sessionName = 'android-post-gesture-freshness';
  const baselineNodes = inboxBaselineNodes(18);
  const changedNodes = buildNodes(
    androidTextRows(18, (row) => (row === 1 ? 'album-0' : `Album row ${row}`)),
  );
  const session = makeAndroidFreshnessSession(sessionName, 'click', baselineNodes);
  session.postGestureStabilization = {
    action: 'click',
    positionals: [],
    markedAt: Date.now(),
  };

  legacyDispatchCapture
    .mockResolvedValueOnce(androidCapture(baselineNodes, { rawNodeCount: 18, maxDepth: 1 }))
    .mockResolvedValueOnce(androidCapture(changedNodes, { rawNodeCount: 18, maxDepth: 1 }))
    .mockResolvedValueOnce(androidCapture(changedNodes, { rawNodeCount: 18, maxDepth: 1 }));

  const result = await captureSnapshot({
    device: androidDevice,
    session,
    flags: { snapshotInteractiveOnly: true },
    logPath: '/tmp/daemon.log',
  });

  expect(result.snapshot.nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: 'album-0' })]),
  );
  expect(legacyDispatchCapture.mock.calls.map((call) => call[1])).toEqual([
    'snapshot',
    'snapshot',
    'snapshot',
  ]);
  expect(session.androidSnapshotFreshness).toBeUndefined();
  expect(session.postGestureStabilization).toBeUndefined();
});
