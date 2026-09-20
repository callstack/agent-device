import { beforeEach, expect, test, vi } from 'vitest';
import type { IosTargetActivation } from '@agent-device/kernel/snapshot';
import { iosTargetActivationDisclosure } from '@agent-device/contracts/ios-target-activation';
import { makeSessionStore } from '../../../../__tests__/test-utils/store-factory.ts';
import { makeIosSession } from '../../../../__tests__/test-utils/session-factories.ts';
import type { DaemonResponse } from '../../../daemon-request.ts';
import { legacyDispatchCapture } from '../../../__tests__/legacy-snapshot-capture-fixture.ts';
import { getRuntimeBindings } from '../../../__tests__/interaction-get-runtime-fixture.ts';
import { handleFindCommands } from '../../index.ts';

vi.mock('../../../snapshot-interactor-capture.ts', async () => {
  const fixture = await import('../../../__tests__/legacy-snapshot-capture-fixture.ts');
  return { captureSnapshotWithInteractor: fixture.captureSnapshotThroughLegacyDispatchFixture };
});

const FACT: IosTargetActivation = {
  reason: 'stale_target',
  priorState: 'runningBackground',
  otherActiveApplicationPid: 4562,
};

const SCREEN = { x: 0, y: 0, width: 390, height: 844 };

/**
 * What the runner answers while the session app is still off foreground, for an interactive-only
 * scoped capture: the application node alone. That is a legacy-sparse tree, so find re-captures
 * unscoped and answers from THAT tree — which is why the repair has to be recorded on the request at
 * capture time rather than read back off the tree that survived (#2682).
 */
const SPARSE_FOREGROUND_REPAIR = {
  backend: 'xctest',
  truncated: false,
  targetActivation: FACT,
  nodes: [{ index: 0, depth: 0, type: 'Application', rect: SCREEN }],
};

/** The same screen one capture later: readable, and reporting no repair of its own. */
const RECOVERED_TREE = {
  backend: 'xctest',
  truncated: false,
  nodes: [
    { index: 0, depth: 0, type: 'Application', rect: SCREEN },
    {
      index: 1,
      parentIndex: 0,
      depth: 1,
      type: 'Cell',
      label: 'General',
      rect: { x: 16, y: 293, width: 370, height: 52 },
      enabled: true,
      hittable: true,
    },
  ],
};

/** A screen that never becomes readable: find answers with the sparse-verdict failure. */
const SPARSE_VERDICT = {
  backend: 'xctest',
  truncated: false,
  targetActivation: FACT,
  quality: {
    state: 'sparse',
    backend: 'xctest',
    reason: 'tree unreadable',
    reasonCode: 'sparse-tree',
  },
  nodes: [{ index: 0, depth: 0, type: 'Application', rect: SCREEN }],
};

beforeEach(() => {
  legacyDispatchCapture.mockReset();
});

async function findClick(captures: Record<string, unknown>[]) {
  const sessionStore = makeSessionStore();
  sessionStore.set('default', makeIosSession('default', { appBundleId: 'com.example.app' }));
  let call = 0;
  legacyDispatchCapture.mockImplementation(
    async () => captures[Math.min(call++, captures.length - 1)],
  );

  const response = await handleFindCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'find',
      positionals: ['General', 'click'],
      flags: {},
    },
    sessionName: 'default',
    logPath: '/tmp/find-target-activation.log',
    sessionStore,
    invoke: async () => ({ ok: true, data: {} }) as DaemonResponse,
    ...getRuntimeBindings(),
  });
  return { response, calls: call };
}

/**
 * The disclosure belongs to the request that paid for the repair. Find's first capture is that
 * request, and when its sparse tree is thrown away in favour of a re-capture, the response that
 * answers from the re-capture still owes the sentence (#2682).
 */
test('a find that recovered from a sparse capture still reports the repair the first capture paid for', async () => {
  const { response, calls } = await findClick([SPARSE_FOREGROUND_REPAIR, RECOVERED_TREE]);

  expect(calls).toBeGreaterThan(1);
  expect(response?.ok).toBe(true);
  if (!response?.ok) return;
  expect(response.data?.targetActivation).toEqual(FACT);
  expect(response.data?.warnings).toEqual([iosTargetActivationDisclosure(FACT)]);
});

/**
 * A sparse tree is still this request's tree. Before the proof moved into the shared capture path,
 * this return was find's only exit that disclosed nothing at all.
 */
test('a find that stayed sparse reports the repair on the failure it returns', async () => {
  const { response } = await findClick([SPARSE_VERDICT]);

  expect(response?.ok).toBe(false);
  if (!response || response.ok) return;
  const hint = String(response.error.details?.hint ?? '');
  expect(hint).toContain(iosTargetActivationDisclosure(FACT));
});
