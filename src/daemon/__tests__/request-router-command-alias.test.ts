import { test, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(async () => ({})) };
});

vi.mock('../device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));

import { dispatchCommand } from '../../core/dispatch.ts';
import { createRequestHandler } from '../request-router.ts';
import type { SessionState } from '../types.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';

const mockDispatch = vi.mocked(dispatchCommand);

function makeIosSession(name: string): SessionState {
  return {
    name,
    createdAt: Date.now(),
    actions: [],
    device: {
      platform: 'apple',
      target: 'mobile',
      id: 'SIM-001',
      name: 'iPhone 16',
      kind: 'simulator',
      booted: true,
      simulatorSetPath: '/tmp/tenant-a/set',
    },
  };
}

function createHandler(sessionStore: ReturnType<typeof makeSessionStore>) {
  return createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
  });
}

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({});
});

// The daemon request boundary is the single compatibility seam for renamed
// commands. It covers command-data/RPC paths that never pass through the CLI
// parser: structured batch steps, recorded replay data, and older remote
// clients that send the wire command directly.
test('daemon boundary rewrites the deprecated rotate command to canonical orientation', async () => {
  const sessionStore = makeSessionStore('agent-device-router-alias-');
  sessionStore.set('qa-ios', makeIosSession('qa-ios'));

  const handler = createHandler(sessionStore);
  const response = await handler({
    token: 'test-token',
    session: 'qa-ios',
    command: 'rotate',
    positionals: ['landscape-left'],
    flags: {},
    meta: { requestId: 'req-rotate-alias' },
  });

  expect(response.ok).toBe(true);
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  // dispatchCommand(device, command, positionals, ...) — the daemon leaf sees the
  // canonical name, so the descriptor/handler resolves instead of failing.
  expect(mockDispatch.mock.calls[0]?.[1]).toBe('orientation');
  expect(mockDispatch.mock.calls[0]?.[2]).toEqual(['landscape-left']);
});

test('daemon boundary leaves canonical commands untouched', async () => {
  const sessionStore = makeSessionStore('agent-device-router-alias-');
  sessionStore.set('qa-ios', makeIosSession('qa-ios'));

  const handler = createHandler(sessionStore);
  await handler({
    token: 'test-token',
    session: 'qa-ios',
    command: 'orientation',
    positionals: ['portrait'],
    flags: {},
    meta: { requestId: 'req-orientation' },
  });

  expect(mockDispatch.mock.calls[0]?.[1]).toBe('orientation');
});

test('daemon boundary does not rewrite relaunch to plain open without its implied flag', async () => {
  const sessionStore = makeSessionStore('agent-device-router-alias-');
  sessionStore.set('qa-ios', makeIosSession('qa-ios'));

  const handler = createHandler(sessionStore);
  await handler({
    token: 'test-token',
    session: 'qa-ios',
    command: 'relaunch',
    positionals: ['com.example.app'],
    flags: {},
    meta: { requestId: 'req-relaunch-alias' },
  });

  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(mockDispatch.mock.calls[0]?.[1]).toBe('relaunch');
  expect(mockDispatch.mock.calls[0]?.[1]).not.toBe('open');
});
