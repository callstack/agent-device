import { beforeEach, expect, test, vi } from 'vitest';
import type {
  CaptureSnapshotInput,
  SnapshotResult,
} from '@agent-device/contracts/snapshot-runtime';
import {
  buildSnapshotPresentationKey,
  type IosTargetActivation,
  type SnapshotState,
} from '@agent-device/kernel/snapshot';
import type { DaemonResponse } from '../daemon-request.ts';
import { type RequestActivationProof, withCaptureDisclosures } from '../capture-disclosure.ts';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { createSelectorCaptureRuntime } from '../selector-capture-runtime.ts';

// R35: the capture runtime executes only through its request-bound capture — there is no
// dispatch seam left to mock, so the tests drive the bound operation the way a real admission
// hands it over.
const boundCapture = vi.fn(async (_input: CaptureSnapshotInput): Promise<SnapshotResult> => ({
  backend: 'xctest',
  producer: 'apple-runner',
  nodes: [],
}));

beforeEach(() => {
  boundCapture.mockReset();
  boundCapture.mockResolvedValue({ backend: 'xctest', producer: 'apple-runner', nodes: [] });
});

test('selector capture cache is keyed by scoped presentation options', async () => {
  const sessionName = 'selector-cache-scope';
  const sessionStore = makeSessionStore('agent-device-selector-capture-');
  const session = makeIosSession(sessionName, {
    snapshot: {
      createdAt: Date.now(),
      presentationKey: buildSnapshotPresentationKey({ scope: 'A' }),
      nodes: [{ ref: 'e1', index: 0, type: 'Button', label: 'A' }],
    },
  });
  sessionStore.set(sessionName, session);
  boundCapture.mockImplementation(async (input) => ({
    backend: 'xctest',
    producer: 'apple-runner',
    nodes: [
      {
        index: 0,
        type: 'Button',
        label: typeof input.options?.scope === 'string' ? input.options.scope : 'broad',
      },
    ],
  }));

  const runtime = createSelectorCaptureRuntime({
    device: session.device,
    session,
    sessionStore,
    sessionName,
    capture: boundCapture,
    req: {
      token: 't',
      session: sessionName,
      command: 'get',
      positionals: [],
      flags: {},
    },
  });

  const first = await runtime.capture({ flags: {}, snapshotScope: 'A' });
  const second = await runtime.capture({ flags: {}, snapshotScope: 'B' });
  const cachedSecond = await runtime.capture({ flags: {}, snapshotScope: 'B' });

  expect(first.snapshot.nodes[0]?.label).toBe('A');
  expect(second.snapshot.nodes[0]?.label).toBe('B');
  expect(cachedSecond.snapshot.nodes[0]?.label).toBe('B');
  expect(boundCapture).toHaveBeenCalledTimes(2);
});

test('legacy iOS sparse recovery retries a full snapshot', async () => {
  const { runtime } = makeCaptureRuntime('selector-legacy-sparse-recovery');
  boundCapture
    .mockResolvedValueOnce({
      backend: 'xctest',
      producer: 'apple-runner',
      nodes: [{ index: 0, type: 'Application' }],
    })
    .mockResolvedValueOnce({
      backend: 'xctest',
      producer: 'apple-runner',
      nodes: [{ index: 0, type: 'Button', label: 'Recovered' }],
    });

  const result = await runtime.capture({
    flags: { snapshotInteractiveOnly: true },
    recovery: {
      legacyIosSparse: {
        query: 'Search',
        shouldScope: false,
      },
    },
  });

  expect(result.snapshot.nodes[0]?.label).toBe('Recovered');
  expect(boundCapture).toHaveBeenCalledTimes(2);
  expect(boundCapture.mock.calls[0]?.[0]?.options).toMatchObject({ interactiveOnly: true });
  expect(boundCapture.mock.calls[1]?.[0]?.options).toMatchObject({ interactiveOnly: false });
});

test('legacy iOS sparse recovery recognizes Appium application element types', async () => {
  const { runtime } = makeCaptureRuntime('selector-appium-sparse-recovery');
  boundCapture
    .mockResolvedValueOnce({
      backend: 'xctest',
      producer: 'appium-source',
      nodes: [{ index: 0, type: 'XCUIElementTypeApplication' }],
    })
    .mockResolvedValueOnce({
      backend: 'xctest',
      producer: 'appium-source',
      nodes: [{ index: 0, type: 'XCUIElementTypeButton', label: 'Recovered' }],
    });

  const result = await runtime.capture({
    flags: { snapshotInteractiveOnly: true },
    recovery: {
      legacyIosSparse: {
        query: 'Search',
        shouldScope: false,
      },
    },
  });

  expect(result.snapshot.nodes[0]?.label).toBe('Recovered');
  expect(boundCapture).toHaveBeenCalledTimes(2);
});

test('legacy iOS sparse recovery rethrows full snapshot failure when scoping is disabled', async () => {
  const { runtime } = makeCaptureRuntime('selector-legacy-sparse-rethrow');
  boundCapture
    .mockResolvedValueOnce({
      backend: 'xctest',
      producer: 'apple-runner',
      nodes: [{ index: 0, type: 'Application' }],
    })
    .mockRejectedValueOnce(new Error('full snapshot failed'));

  await expect(
    runtime.capture({
      flags: { snapshotInteractiveOnly: true },
      recovery: {
        legacyIosSparse: {
          query: 'Search',
          shouldScope: false,
        },
      },
    }),
  ).rejects.toThrow('full snapshot failed');
  expect(boundCapture).toHaveBeenCalledTimes(2);
});

test('sparse verdict recovery retries with query scope and stores recovered snapshot', async () => {
  const { runtime, sessionName, sessionStore } = makeCaptureRuntime('selector-sparse-verdict');
  boundCapture
    .mockResolvedValueOnce({
      backend: 'xctest',
      producer: 'apple-runner',
      quality: {
        state: 'sparse',
        backend: 'private-ax',
        reason: 'sparse tree',
        reasonCode: 'sparse-tree',
      },
      nodes: [{ index: 0, type: 'Application' }],
    })
    .mockResolvedValueOnce({
      backend: 'xctest',
      producer: 'apple-runner',
      nodes: [{ index: 0, type: 'Button', label: 'Search' }],
    });

  const result = await runtime.capture({
    flags: { snapshotInteractiveOnly: true },
    recovery: {
      sparseVerdictQueryScope: {
        query: 'Search',
        shouldScope: true,
      },
    },
  });

  expect(result.snapshot.nodes[0]?.label).toBe('Search');
  expect(sessionStore.get(sessionName)?.snapshot?.nodes[0]?.label).toBe('Search');
  expect(boundCapture).toHaveBeenCalledTimes(2);
  expect(boundCapture.mock.calls[1]?.[0]?.options).toMatchObject({
    interactiveOnly: false,
    scope: 'Search',
  });
});

const REPAIR: IosTargetActivation = {
  reason: 'stale_target',
  priorState: 'runningBackground',
  otherActiveApplicationPid: 4562,
};

function proofRuntime(params: {
  sessionName: string;
  storedSnapshot?: SnapshotState;
  capturedTargetActivation?: IosTargetActivation;
}) {
  const sessionStore = makeSessionStore('agent-device-selector-capture-');
  const session = makeIosSession(
    params.sessionName,
    params.storedSnapshot ? { snapshot: params.storedSnapshot } : {},
  );
  sessionStore.set(params.sessionName, session);
  boundCapture.mockResolvedValue({
    backend: 'xctest',
    producer: 'apple-runner',
    nodes: [{ index: 0, type: 'Button', label: 'Captured' }],
    ...(params.capturedTargetActivation
      ? { targetActivation: params.capturedTargetActivation }
      : {}),
  } as never);
  const consumedSnapshot: { state?: SnapshotState } = {};
  const activationProof: RequestActivationProof = {};
  const runtime = createSelectorCaptureRuntime({
    device: session.device,
    session,
    sessionStore,
    sessionName: params.sessionName,
    consumedSnapshot,
    activationProof,
    capture: boundCapture,
    req: {
      token: 't',
      session: params.sessionName,
      command: 'get',
      positionals: [],
      flags: {},
    },
  });
  return { runtime, consumedSnapshot, activationProof };
}

/**
 * A selector read answered from the tree an earlier command stored performed no device work, so it
 * owns no foreground repair (#2682). The stored tree may still be disclosed as the surface the
 * response describes (#2438); the repair sentence is a claim about THIS command and would be
 * fabricated here.
 */
test('a session-snapshot cache hit consumes a repaired tree without earning the repair proof', async () => {
  const holders = proofRuntime({
    sessionName: 'selector-cache-hit-repair-proof',
    storedSnapshot: {
      createdAt: Date.now(),
      presentationKey: buildSnapshotPresentationKey({}),
      nodes: [{ ref: 'e1', index: 0, type: 'Button', label: 'Stored' }],
      targetActivation: REPAIR,
    },
  });

  await holders.runtime.capture({ flags: {}, cache: { useSessionSnapshot: true } });

  expect(boundCapture).not.toHaveBeenCalled();
  expect(holders.consumedSnapshot.state?.targetActivation).toEqual(REPAIR);
  expect(holders.activationProof.state).toBeUndefined();

  const response = withCaptureDisclosures({
    response: { ok: true, data: { nodes: [] } } as DaemonResponse,
    consumedTree: holders.consumedSnapshot.state,
    activationProof: holders.activationProof,
  });
  expect(response.ok).toBe(true);
  if (response.ok) {
    expect(response.data?.targetActivation).toBeUndefined();
    expect(response.data?.warnings).toBeUndefined();
  }
});

test('a capture the request took itself earns the repair proof', async () => {
  const holders = proofRuntime({
    sessionName: 'selector-fresh-capture-repair-proof',
    capturedTargetActivation: REPAIR,
  });

  await holders.runtime.capture({ flags: {}, cache: { useSessionSnapshot: true } });

  expect(boundCapture).toHaveBeenCalledTimes(1);
  expect(holders.activationProof.state?.targetActivation).toEqual(REPAIR);
});

/**
 * A poll or a recovery re-capture inside one request can answer from an already-foreground app while
 * an earlier capture in that same request reported the repair. The later fact-less tree must not
 * erase the disclosure the request earned (#2682).
 */
test('a later fact-less capture does not erase an earlier repair proof', async () => {
  const holders = proofRuntime({
    sessionName: 'selector-second-capture-keeps-proof',
    capturedTargetActivation: REPAIR,
  });

  await holders.runtime.capture({ flags: {}, cache: { forceFresh: true } });
  boundCapture.mockResolvedValue({
    backend: 'xctest',
    producer: 'apple-runner',
    nodes: [{ index: 0, type: 'Button', label: 'Quiet' }],
  } as never);
  await holders.runtime.capture({ flags: {}, cache: { forceFresh: true } });

  expect(boundCapture).toHaveBeenCalledTimes(2);
  expect(holders.activationProof.state?.targetActivation).toEqual(REPAIR);
});

function makeCaptureRuntime(sessionName: string) {
  const sessionStore = makeSessionStore('agent-device-selector-capture-');
  const session = makeIosSession(sessionName);
  sessionStore.set(sessionName, session);
  const runtime = createSelectorCaptureRuntime({
    device: session.device,
    session,
    sessionStore,
    sessionName,
    capture: boundCapture,
    req: {
      token: 't',
      session: sessionName,
      command: 'find',
      positionals: [],
      flags: {},
    },
  });
  return { runtime, sessionName, sessionStore };
}
