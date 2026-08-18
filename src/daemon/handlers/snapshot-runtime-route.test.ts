import { beforeEach, expect, test, vi } from 'vitest';

const { dispatchSnapshotDiffViaRuntime, dispatchSnapshotViaRuntime } = vi.hoisted(() => ({
  dispatchSnapshotDiffViaRuntime: vi.fn(),
  dispatchSnapshotViaRuntime: vi.fn(),
}));

vi.mock('../snapshot-diff-runtime.ts', () => ({
  dispatchSnapshotDiffViaRuntime,
}));

vi.mock('../snapshot-runtime.ts', () => ({
  dispatchSnapshotViaRuntime,
}));

import { SessionStore } from '../session-store.ts';
import type { DaemonRequest } from '../types.ts';
import { handleSnapshotCommands } from './snapshot.ts';

beforeEach(() => {
  dispatchSnapshotDiffViaRuntime.mockReset();
  dispatchSnapshotViaRuntime.mockReset();
  dispatchSnapshotDiffViaRuntime.mockResolvedValue({ ok: true, data: {} });
  dispatchSnapshotViaRuntime.mockResolvedValue({ ok: true, data: {} });
});

test('snapshot route forwards the request runtime facts and binding seams exactly once', async () => {
  const inspectFacts = vi.fn();
  const bindDevice = vi.fn();
  const sessionStore = new SessionStore('/tmp/agent-device-snapshot-runtime-route-test');
  const req: DaemonRequest = {
    command: 'snapshot',
    positionals: [],
    session: 'snapshot-route',
    token: 'test-token',
  };

  await handleSnapshotCommands({
    req,
    sessionName: 'snapshot-route',
    logPath: '/tmp/snapshot-route.log',
    sessionStore,
    inspectFacts,
    bindDevice,
  });

  expect(dispatchSnapshotViaRuntime).toHaveBeenCalledOnce();
  expect(dispatchSnapshotViaRuntime).toHaveBeenCalledWith({
    req,
    sessionName: 'snapshot-route',
    logPath: '/tmp/snapshot-route.log',
    sessionStore,
    inspectFacts,
    bindDevice,
  });
  expect(dispatchSnapshotDiffViaRuntime).not.toHaveBeenCalled();
});

test('diff route forwards the request runtime facts and binding seams exactly once', async () => {
  const inspectFacts = vi.fn();
  const bindDevice = vi.fn();
  const sessionStore = new SessionStore('/tmp/agent-device-snapshot-diff-route-test');
  const req: DaemonRequest = {
    command: 'diff',
    positionals: ['snapshot'],
    session: 'diff-route',
    token: 'test-token',
  };

  await handleSnapshotCommands({
    req,
    sessionName: 'diff-route',
    logPath: '/tmp/diff-route.log',
    sessionStore,
    inspectFacts,
    bindDevice,
  });

  expect(dispatchSnapshotDiffViaRuntime).toHaveBeenCalledOnce();
  expect(dispatchSnapshotDiffViaRuntime).toHaveBeenCalledWith({
    req,
    sessionName: 'diff-route',
    logPath: '/tmp/diff-route.log',
    sessionStore,
    inspectFacts,
    bindDevice,
  });
  expect(dispatchSnapshotViaRuntime).not.toHaveBeenCalled();
});
