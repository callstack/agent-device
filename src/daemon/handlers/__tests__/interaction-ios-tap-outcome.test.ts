import { beforeEach, expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { buildSnapshotState } from '../snapshot-capture.ts';
import { handleInteractionCommands } from '../interaction.ts';
import { dispatchCommand } from '../../../core/dispatch.ts';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import type { CommandFlags } from '../../../core/dispatch.ts';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchCommand: vi.fn(async () => ({})),
  };
});

const mockDispatch = vi.mocked(dispatchCommand);

const contextFromFlags = (flags: CommandFlags | undefined) => ({
  count: flags?.count,
  intervalMs: flags?.intervalMs,
  delayMs: flags?.delayMs,
  holdMs: flags?.holdMs,
  jitterPx: flags?.jitterPx,
  doubleTap: flags?.doubleTap,
  clickButton: flags?.clickButton,
});

const profileNodes = [
  {
    index: 0,
    type: 'Application',
    label: 'Profile',
    rect: { x: 0, y: 0, width: 390, height: 844 },
  },
  {
    index: 1,
    parentIndex: 0,
    type: 'Button',
    identifier: 'unfollow',
    label: 'Unfollow',
    rect: { x: 24, y: 200, width: 160, height: 44 },
    hittable: true,
  },
];

const imageViewerNodes = [
  {
    index: 0,
    type: 'Application',
    label: 'Image viewer',
    rect: { x: 0, y: 0, width: 390, height: 844 },
  },
  {
    index: 1,
    parentIndex: 0,
    type: 'Button',
    identifier: 'close-image',
    label: 'Close image',
    rect: { x: 24, y: 40, width: 120, height: 44 },
    hittable: true,
  },
];

function snapshot(nodes: typeof profileNodes) {
  return buildSnapshotState({ nodes, backend: 'xctest' }, { snapshotInteractiveOnly: false });
}

async function runClick(
  sessionStore: ReturnType<typeof makeSessionStore>,
  sessionName: string,
): Promise<Awaited<ReturnType<typeof handleInteractionCommands>>> {
  return await handleInteractionCommands({
    req: {
      token: 'test',
      session: sessionName,
      command: 'click',
      positionals: ['id="unfollow"'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });
}

beforeEach(() => {
  mockDispatch.mockReset();
});

test('a changed post-action capture corroborates a direct iOS tap reported as failed', async () => {
  const sessionName = 'ios-direct-tap-corroboration';
  const sessionStore = makeSessionStore();
  const session = makeIosSession(sessionName, {
    appBundleId: 'com.example.app',
    snapshot: snapshot(profileNodes),
  });
  sessionStore.set(sessionName, session);
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'press') {
      throw new AppError(
        'XCTEST_RECORDED_FAILURE',
        'XCTest recorded a failure while executing tap; the action may not have been performed.',
      );
    }
    if (command === 'snapshot') return { backend: 'xctest', nodes: imageViewerNodes };
    return {};
  });

  const response = await runClick(sessionStore, sessionName);

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.warning).toMatch(/post-action accessibility capture changed/);
    expect(response.data?.selector).toBe('id="unfollow"');
  }
  expect(mockDispatch.mock.calls.filter((call) => call[1] === 'press')).toHaveLength(1);
  expect(sessionStore.get(sessionName)?.actions).toHaveLength(1);
});

test('an unchanged post-action capture keeps a failed iOS tap failed', async () => {
  const sessionName = 'ios-unchanged-tap-corroboration';
  const sessionStore = makeSessionStore();
  const session = makeIosSession(sessionName, {
    appBundleId: 'com.example.app',
    snapshot: snapshot(profileNodes),
  });
  sessionStore.set(sessionName, session);
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'press') {
      throw new AppError(
        'XCTEST_RECORDED_FAILURE',
        'XCTest recorded a failure while executing tap; the action may not have been performed.',
      );
    }
    if (command === 'snapshot') return { backend: 'xctest', nodes: profileNodes };
    return {};
  });

  const response = await runClick(sessionStore, sessionName);

  expect(response?.ok).toBe(false);
  if (response && !response.ok) expect(response.error.code).toBe('XCTEST_RECORDED_FAILURE');
  expect(sessionStore.get(sessionName)?.actions).toHaveLength(0);
});

test('runtime-resolved taps use the same corroboration boundary', async () => {
  const sessionName = 'ios-runtime-tap-corroboration';
  const sessionStore = makeSessionStore();
  sessionStore.set(
    sessionName,
    makeIosSession(sessionName, {
      appBundleId: 'com.example.app',
      recordSession: true,
    }),
  );
  let snapshotCount = 0;
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'press') {
      throw new AppError(
        'XCTEST_RECORDED_FAILURE',
        'XCTest recorded a failure while executing tap; the action may not have been performed.',
      );
    }
    if (command === 'snapshot') {
      snapshotCount += 1;
      return {
        backend: 'xctest',
        nodes: snapshotCount === 1 ? profileNodes : imageViewerNodes,
      };
    }
    return {};
  });

  const response = await runClick(sessionStore, sessionName);

  expect(response?.ok).toBe(true);
  if (response?.ok)
    expect(response.data?.warning).toMatch(/post-action accessibility capture changed/);
  expect(snapshotCount).toBe(2);
  expect(sessionStore.get(sessionName)?.actions).toHaveLength(1);
});
