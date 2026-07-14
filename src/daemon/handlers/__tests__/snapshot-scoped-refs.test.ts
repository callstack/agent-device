import { beforeEach, expect, test, vi } from 'vitest';
import { handleSnapshotCommands } from '../snapshot.ts';
import type { RawSnapshotNode, SnapshotState } from '../../../kernel/snapshot.ts';
import { dispatchCommand } from '../../../core/dispatch.ts';
import { makeAndroidSession } from '../../../__tests__/test-utils/index.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { expireRefFrame } from '../../ref-frame.ts';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchCommand: vi.fn(async () => ({})),
  };
});

const mockDispatch = vi.mocked(dispatchCommand);
const ANDROID_SCRIPT_ERROR = 'Unable to load script. Make sure you are running Metro.';

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({});
});

test('snapshot resolves @ref scope with the stored source after scoped output replaces refs', async () => {
  const sessionStore = makeSessionStore('agent-device-snapshot-scoped-refs-');
  const sessionName = 'android-ref-scope-repeat';
  const session = makeAndroidSession(sessionName, { snapshot: androidRefScopeSourceSnapshot() });
  sessionStore.set(sessionName, session);

  mockDispatch.mockResolvedValue({
    nodes: scopedScriptErrorNodes(),
    truncated: false,
    backend: 'android',
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await requestScopedSnapshot(sessionName, sessionStore, '@e3');

    expect(response?.ok).toBe(true);
    if (response?.ok) expect(response.data?.nodes).toHaveLength(2);
  }

  expect(mockDispatch).toHaveBeenCalledTimes(2);
  expect(mockDispatch.mock.calls.map((call) => call[4])).toEqual([
    expect.objectContaining({ snapshotScope: ANDROID_SCRIPT_ERROR }),
    expect.objectContaining({ snapshotScope: ANDROID_SCRIPT_ERROR }),
  ]);
  expect(sessionStore.get(sessionName)?.snapshot?.nodes).toHaveLength(2);
  expect(sessionStore.get(sessionName)?.snapshotScopeSource?.nodes[2]?.ref).toBe('e3');
});

test('a mutation clears scoped-snapshot lineage so a repeated snapshot -s @ref cannot borrow it (ADR 0014)', async () => {
  const sessionStore = makeSessionStore('agent-device-snapshot-scoped-refs-');
  const sessionName = 'android-ref-scope-broken-by-mutation';
  const session = makeAndroidSession(sessionName, { snapshot: androidRefScopeSourceSnapshot() });
  sessionStore.set(sessionName, session);

  mockDispatch.mockResolvedValue({
    nodes: scopedScriptErrorNodes(),
    truncated: false,
    backend: 'android',
  });

  // First scoped snapshot establishes the lineage and reindexes the stored refs
  // (the reduced output no longer contains @e3).
  const first = await requestScopedSnapshot(sessionName, sessionStore, '@e3');
  expect(first?.ok).toBe(true);
  expect(sessionStore.get(sessionName)?.snapshotScopeSource?.nodes[2]?.ref).toBe('e3');

  // A device mutation crosses the side-effect seam and clears the lineage.
  expireRefFrame(sessionStore.get(sessionName)!);
  expect(sessionStore.get(sessionName)?.snapshotScopeSource).toBeUndefined();

  // The repeated `snapshot -s @e3` can no longer borrow the stale lineage: the
  // reindexed stored tree has no @e3, so it fails closed rather than resolving a
  // different subtree.
  const second = await requestScopedSnapshot(sessionName, sessionStore, '@e3');
  expect(second?.ok).toBe(false);
});

test('empty @ref-scoped snapshot output does not replace the stored session snapshot', async () => {
  const sessionStore = makeSessionStore('agent-device-snapshot-scoped-refs-');
  const sessionName = 'android-empty-scope-preserve';
  const session = makeAndroidSession(sessionName, { snapshot: currentScreenSnapshot() });
  sessionStore.set(sessionName, session);

  mockDispatch.mockResolvedValue({
    nodes: [],
    truncated: false,
    backend: 'android',
  });

  const response = await requestScopedSnapshot(sessionName, sessionStore, '@e1');

  expect(response?.ok).toBe(true);
  if (response?.ok) expect(response.data?.nodes).toEqual([]);
  expect(sessionStore.get(sessionName)?.snapshot?.nodes[0]?.label).toBe('Current screen');
});

function requestScopedSnapshot(
  sessionName: string,
  sessionStore: ReturnType<typeof makeSessionStore>,
  snapshotScope: string,
) {
  return handleSnapshotCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'snapshot',
      positionals: [],
      flags: { snapshotScope },
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });
}

function currentScreenSnapshot(): SnapshotState {
  return {
    nodes: [
      { ref: 'e1', index: 0, depth: 0, type: 'android.widget.TextView', label: 'Current screen' },
    ],
    createdAt: Date.now(),
    backend: 'android',
  };
}

function androidRefScopeSourceSnapshot(): SnapshotState {
  return {
    nodes: [
      {
        ref: 'e1',
        index: 0,
        depth: 0,
        type: 'android.widget.FrameLayout',
        rect: { x: 0, y: 0, width: 390, height: 844 },
      },
      {
        ref: 'e2',
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'androidx.recyclerview.widget.RecyclerView',
        rect: { x: 0, y: 80, width: 390, height: 600 },
      },
      {
        ref: 'e3',
        index: 2,
        depth: 2,
        parentIndex: 1,
        type: 'android.widget.TextView',
        label: ANDROID_SCRIPT_ERROR,
        value: ANDROID_SCRIPT_ERROR,
        rect: { x: 16, y: 120, width: 358, height: 200 },
      },
      {
        ref: 'e4',
        index: 3,
        depth: 3,
        parentIndex: 2,
        type: 'android.widget.TextView',
        label: 'loadJSBundleFromAssets',
        rect: { x: 16, y: 140, width: 358, height: 40 },
      },
    ],
    createdAt: Date.now(),
    backend: 'android',
  };
}

function scopedScriptErrorNodes(): RawSnapshotNode[] {
  return [
    {
      index: 0,
      depth: 0,
      type: 'android.widget.TextView',
      label: ANDROID_SCRIPT_ERROR,
      value: ANDROID_SCRIPT_ERROR,
      rect: { x: 16, y: 120, width: 358, height: 200 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'android.widget.TextView',
      label: 'loadJSBundleFromAssets',
      rect: { x: 16, y: 140, width: 358, height: 40 },
    },
  ];
}
