import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { iosTargetActivationDisclosure } from '@agent-device/contracts/ios-target-activation';
import type { IosTargetActivation } from '@agent-device/kernel/snapshot';
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
    };
  }
  sessionStore.set(sessionName, session);
  return { sessionStore, sessionName, logPath: path.join(root, 'daemon.log') };
}

async function dispatchSnapshot(input: ReturnType<typeof scenario>) {
  const response = await handleSnapshotCommands({
    req: { command: 'snapshot', positionals: [], token: 't', session: input.sessionName },
    sessionName: input.sessionName,
    logPath: input.logPath,
    sessionStore: input.sessionStore,
    ...snapshotRuntimeFixture(),
  });
  if (!response) throw new Error('snapshot route did not answer');
  return response;
}
