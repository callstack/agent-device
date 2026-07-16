import { beforeEach, expect, test, vi } from 'vitest';
import { dispatchCommand } from '../../core/dispatch.ts';
import { buildSnapshotPresentationKey } from '../../kernel/snapshot.ts';
import { makeIosSession } from '../../__tests__/test-utils/index.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { createSelectorCaptureRuntime } from '../selector-capture-runtime.ts';

vi.mock('../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchCommand: vi.fn(async () => ({})),
  };
});

const mockDispatch = vi.mocked(dispatchCommand);

beforeEach(() => {
  mockDispatch.mockReset();
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
  mockDispatch.mockImplementation(async (_device, _command, _positionals, _outPath, context) => ({
    backend: 'xctest',
    nodes: [
      {
        index: 0,
        type: 'Button',
        label:
          context && typeof context.snapshotScope === 'string' ? context.snapshotScope : 'broad',
      },
    ],
  }));

  const runtime = createSelectorCaptureRuntime({
    device: session.device,
    session,
    sessionStore,
    sessionName,
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
  expect(mockDispatch).toHaveBeenCalledTimes(2);
});

test('legacy iOS sparse recovery retries a full snapshot', async () => {
  const { runtime } = makeCaptureRuntime('selector-legacy-sparse-recovery');
  mockDispatch
    .mockResolvedValueOnce({
      backend: 'xctest',
      nodes: [{ index: 0, type: 'Application' }],
    })
    .mockResolvedValueOnce({
      backend: 'xctest',
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
  expect(mockDispatch).toHaveBeenCalledTimes(2);
  expect(mockDispatch.mock.calls[0]?.[4]).toMatchObject({ snapshotInteractiveOnly: true });
  expect(mockDispatch.mock.calls[1]?.[4]).toMatchObject({ snapshotInteractiveOnly: false });
});

test('legacy iOS sparse recovery rethrows full snapshot failure when scoping is disabled', async () => {
  const { runtime } = makeCaptureRuntime('selector-legacy-sparse-rethrow');
  mockDispatch
    .mockResolvedValueOnce({
      backend: 'xctest',
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
  expect(mockDispatch).toHaveBeenCalledTimes(2);
});

test('sparse verdict recovery retries with query scope and stores recovered snapshot', async () => {
  const { runtime, sessionName, sessionStore } = makeCaptureRuntime('selector-sparse-verdict');
  mockDispatch
    .mockResolvedValueOnce({
      backend: 'xctest',
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
  expect(mockDispatch).toHaveBeenCalledTimes(2);
  expect(mockDispatch.mock.calls[1]?.[4]).toMatchObject({
    snapshotInteractiveOnly: false,
    snapshotScope: 'Search',
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
