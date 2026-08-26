import { beforeEach, expect, test, vi } from 'vitest';
import type {
  CaptureSnapshotInput,
  SnapshotResult,
} from '@agent-device/contracts/snapshot-runtime';
import { buildSnapshotPresentationKey } from '@agent-device/kernel/snapshot';
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
