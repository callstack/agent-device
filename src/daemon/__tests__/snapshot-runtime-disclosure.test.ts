import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { iosTargetActivationDisclosure } from '@agent-device/contracts/ios-target-activation';
import type { IosTargetActivation, PostGestureOutcome } from '@agent-device/kernel/snapshot';
import { formatPostGestureOutcomeWarning } from '@agent-device/capture-kit/post-gesture-stability';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { markDeferredInteractionOutcome } from '../deferred-interaction-outcome.ts';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { SessionStore } from '../session-store.ts';
import { handleSnapshotCommands } from '../handlers/snapshot.ts';
import { legacyDispatchCapture } from './legacy-snapshot-capture-fixture.ts';
import { snapshotRuntimeFixture } from './snapshot-runtime-fixture.ts';

vi.mock('../snapshot-interactor-capture.ts', async () => {
  const fixture = await import('./legacy-snapshot-capture-fixture.ts');
  return { captureSnapshotWithInteractor: fixture.captureSnapshotThroughLegacyDispatchFixture };
});

const REPAIR: IosTargetActivation = {
  reason: 'stale_target',
  priorState: 'runningBackground',
  otherActiveApplicationPid: 4562,
};

beforeEach(() => {
  legacyDispatchCapture.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

test('a snapshot that captured a repaired tree discloses the repair it paid for', async () => {
  const input = scenario({});
  legacyDispatchCapture.mockResolvedValue({
    backend: 'xctest',
    truncated: false,
    targetActivation: REPAIR,
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        label: 'Continue',
        rect: { x: 0, y: 0, width: 100, height: 44 },
        hittable: true,
      },
    ],
  });

  const response = await dispatchSnapshot(input);

  expect(response.ok).toBe(true);
  if (response.ok) {
    expect(response.data?.targetActivation).toEqual(REPAIR);
    expect(response.data?.warnings).toContain(iosTargetActivationDisclosure(REPAIR));
  }
});

/**
 * The stored snapshot is the PREVIOUS command's tree. A snapshot that never captured — refused before
 * the platform was reached, or answered by a capture that reported no repair — may not borrow its
 * predecessor's repair or predecessor's surface. The failure hint is exactly where a route could
 * cheaply blame this request for a foreground move and a system sheet it never observed, and the
 * success carrier is where it could copy the #2438 sentence its own capture already spoke (#2682).
 */
test('a snapshot whose capture reported no repair borrows nothing from the stored tree', async () => {
  const input = scenario({ storedRepair: true });
  legacyDispatchCapture.mockResolvedValue({
    backend: 'xctest',
    truncated: false,
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        label: 'Continue',
        rect: { x: 0, y: 0, width: 100, height: 44 },
        hittable: true,
      },
    ],
  });

  const response = await dispatchSnapshot(input);

  expect(response.ok).toBe(true);
  if (response.ok) {
    expect(response.data?.targetActivation).toBeUndefined();
    const warnings = (response.data?.warnings ?? []) as string[];
    expect(warnings).not.toContain(iosTargetActivationDisclosure(REPAIR));
    expect(warnings.join(' ')).not.toContain('system web sign-in sheet');
  }
});

test('a snapshot refused before it captured reports no repair and no surface it never observed', async () => {
  const input = scenario({ storedRepair: true });

  // A ref scope the stored tree cannot resolve is refused before the device is asked for anything,
  // so this response's only candidate evidence is the previous command's stored snapshot.
  const response = await dispatchSnapshot(input, { snapshotScope: '@e99' });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  const hint = String(response.error.hint ?? '');
  expect(hint.includes(iosTargetActivationDisclosure(REPAIR))).toBe(false);
  expect(hint.includes('was not foreground')).toBe(false);
  expect(hint.includes('system web sign-in sheet')).toBe(false);
  expect(JSON.stringify(response.error.details ?? {})).not.toContain('targetActivation');
});

/** A scroll that moved nothing reaches the agent on the snapshot that proved it (#1600). */
test('a snapshot after a scroll that moved nothing warns and stamps the no-effect outcome', async () => {
  const input = scenario({});
  const button = {
    index: 0,
    depth: 0,
    type: 'Button',
    label: 'Continue',
    rect: { x: 0, y: 0, width: 100, height: 44 },
    hittable: true,
  };
  const session = input.sessionStore.get(input.sessionName)!;
  session.snapshot = makeSnapshotState([button], { backend: 'xctest' });
  markDeferredInteractionOutcome({ session, command: 'scroll', positionals: ['up'], flags: {} });
  legacyDispatchCapture.mockResolvedValue({ backend: 'xctest', truncated: false, nodes: [button] });
  const outcome: PostGestureOutcome = {
    kind: 'no-effect',
    gesture: { action: 'scroll', positionals: ['up'] },
  };

  const realSetTimeout = globalThis.setTimeout;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  let done = false;
  const pending = dispatchSnapshot(input).finally(() => (done = true));
  // The route awaits real I/O between polls, so the faked clock advances while the test yields.
  while (!done) {
    await vi.advanceTimersByTimeAsync(100);
    await new Promise((resolve) => realSetTimeout(resolve, 1));
  }
  const response = await pending;

  expect(response.ok && response.data?.warnings).toContain(
    formatPostGestureOutcomeWarning(outcome),
  );
  expect(input.sessionStore.get(input.sessionName)?.snapshot?.postGestureOutcome).toEqual(outcome);
});

function scenario(params: { storedRepair?: boolean }) {
  const root = mkdtempForTestSync('agent-device-snapshot-target-activation');
  const sessionName = 'default';
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const session = makeIosSession(sessionName, { appBundleId: 'com.example.app' });
  if (params.storedRepair) {
    session.snapshot = {
      createdAt: Date.now(),
      nodes: [{ ref: 'e1', index: 0, type: 'Button', label: 'Earlier' }],
      targetActivation: REPAIR,
      iosSystemSurfaceBundleId: 'com.apple.SafariViewService',
    };
  }
  sessionStore.set(sessionName, session);
  return { sessionStore, sessionName, logPath: path.join(root, 'daemon.log') };
}

async function dispatchSnapshot(
  input: ReturnType<typeof scenario>,
  flags: Record<string, unknown> = {},
) {
  const response = await handleSnapshotCommands({
    req: {
      command: 'snapshot',
      positionals: [],
      token: 't',
      session: input.sessionName,
      flags,
    },
    sessionName: input.sessionName,
    logPath: input.logPath,
    sessionStore: input.sessionStore,
    ...snapshotRuntimeFixture(),
  });
  if (!response) throw new Error('snapshot route did not answer');
  return response;
}
