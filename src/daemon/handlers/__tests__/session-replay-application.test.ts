import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import type { RequestProgressEvent } from '@agent-device/contracts/progress';
import type { PlatformResourceCleanup } from '@agent-device/contracts/platform-resource-cleanup';
import {
  clearRequestCanceled,
  markRequestCanceled,
  registerRequestAbort,
  withRequestProgressSink,
} from '@agent-device/host-kit/request';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import { withClientReplayScriptSources } from '../../../__tests__/test-utils/replay-script-source.ts';
import type { DaemonRequest, DaemonResponse } from '../../types.ts';
import { SessionStore } from '../../session-store.ts';
import { LeaseRegistry } from '../../lease-registry.ts';
import { handleSessionReplayCommands } from '../session-replay.ts';
import { captureSnapshotWithInteractor } from '../snapshot-interactor-capture.ts';
import {
  legacyDispatchCapture,
  resetLegacySnapshotCapture,
} from '../../__tests__/legacy-snapshot-capture-fixture.ts';
import { baseReplayRequest, writeReplayFile } from './session-replay-runtime.fixtures.ts';

vi.mock('../snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));

const mockCaptureSnapshotWithInteractor = vi.mocked(captureSnapshotWithInteractor);

const noopPlatformResourceCleanup = Object.freeze({
  stopSnapshotHelper: async () => {},
  closeManagedBrowser: async () => {},
  cleanupSessionlessExecutionHost: async () => {},
  retainExecutionHostAfterClose: () => false,
}) satisfies PlatformResourceCleanup;

beforeEach(() => {
  resetLegacySnapshotCapture(mockCaptureSnapshotWithInteractor);
});

function replayParams(
  req: DaemonRequest,
  root: string,
  sessionStore: SessionStore,
  invoke: (request: DaemonRequest) => Promise<DaemonResponse>,
) {
  return {
    req,
    sessionName: req.session,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    invoke,
  };
}

function suiteParams(
  req: DaemonRequest,
  root: string,
  sessionStore: SessionStore,
  invoke: (request: DaemonRequest) => Promise<DaemonResponse>,
) {
  return {
    ...replayParams(req, root, sessionStore, invoke),
    platformResourceCleanup: noopPlatformResourceCleanup,
  };
}

test('replay routes native and Maestro sources through one application seam and keeps the session', async () => {
  const cases = [
    {
      kind: 'native',
      buildRequest: (root: string) => {
        const filePath = writeReplayFile(root, ['open "Native"']);
        return baseReplayRequest({ positionals: [filePath], flags: { platform: 'ios' } });
      },
      expectedCommands: ['open'],
    },
    {
      kind: 'Maestro',
      buildRequest: async (root: string) => {
        const filePath = path.join(root, 'flow.yaml');
        fs.writeFileSync(
          filePath,
          ['appId: com.example.app', '---', '- launchApp', '- inputText: typed'].join('\n'),
        );
        return await withClientReplayScriptSources({
          token: 'token',
          session: 'default',
          command: 'replay',
          positionals: [filePath],
          flags: { replayBackend: 'maestro', platform: 'ios' },
        });
      },
      expectedCommands: ['open', 'type'],
    },
  ] as const;

  for (const replayCase of cases) {
    const root = mkdtempForTestSync(`agent-device-replay-application-${replayCase.kind}-`);
    const sessionStore = new SessionStore(path.join(root, 'sessions'));
    sessionStore.set('default', makeIosSession('default'));
    const req = await replayCase.buildRequest(root);
    const invoked: DaemonRequest[] = [];

    const response = await handleSessionReplayCommands(
      replayParams(req, root, sessionStore, async (request) => {
        invoked.push(request);
        return request.command === 'snapshot'
          ? { ok: true, data: { createdAt: 0, nodes: [] } }
          : { ok: true, data: {} };
      }),
    );

    expect(response).toMatchObject({
      ok: true,
      data: { replayed: replayCase.expectedCommands.length },
    });
    if (!response?.ok) continue;
    expect(response.data?.sessionActive).toBe(true);
    expect(
      invoked.filter(({ command }) => command !== 'snapshot').map(({ command }) => command),
    ).toEqual(replayCase.expectedCommands);
  }
});

test('replay admits an annotated target before dispatching its mutation', async () => {
  const root = mkdtempForTestSync('agent-device-replay-application-admission-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  sessionStore.set('default', makeIosSession('default', { appBundleId: 'com.example.app' }));
  const filePath = writeReplayFile(root, [
    '# agent-device:target-v1 {"id":"save","role":"button","label":"Save","ancestry":[],"sibling":0,"viewportOrder":0,"verification":"verified"}',
    'click label="Save"',
  ]);
  legacyDispatchCapture.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        identifier: 'renamed-save',
        label: 'Save',
        rect: { x: 10, y: 10, width: 40, height: 20 },
      },
    ],
    truncated: false,
    backend: 'xctest',
  });
  const invoked = vi.fn(async () => ({ ok: true as const, data: {} }));

  const response = await handleSessionReplayCommands(
    replayParams(baseReplayRequest({ positionals: [filePath] }), root, sessionStore, invoked),
  );

  expect(invoked).not.toHaveBeenCalled();
  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'REPLAY_DIVERGENCE',
      details: { divergence: { kind: 'identity-mismatch' } },
    },
  });
});

test('replay projects the exact failure cause and retains artifacts from the failed step', async () => {
  const root = mkdtempForTestSync('agent-device-replay-application-failure-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  sessionStore.set('default', makeIosSession('default'));
  const artifactPath = path.join(root, 'failure.png');
  fs.writeFileSync(artifactPath, 'artifact');
  const filePath = writeReplayFile(root, ['open "Demo"']);
  mockCaptureSnapshotWithInteractor.mockRejectedValue(new Error('capture unavailable'));

  const response = await handleSessionReplayCommands(
    replayParams(baseReplayRequest({ positionals: [filePath] }), root, sessionStore, async () => ({
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: 'runner failed',
        hint: 'retry the open',
        diagnosticId: 'diag-1',
        logPath: '/tmp/runner.log',
        details: { reason: 'runner-timeout', artifactPaths: [artifactPath] },
      },
    })),
  );

  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'REPLAY_DIVERGENCE',
      message: 'Replay failed at step 1 (open "Demo"): runner failed',
      hint: 'retry the open',
      diagnosticId: 'diag-1',
      logPath: '/tmp/runner.log',
      details: {
        reason: 'runner-timeout',
        replayPath: filePath,
        step: 1,
        action: 'open',
        positionals: ['<arg>'],
        artifactPaths: [artifactPath],
        divergence: {
          kind: 'action-failure',
          cause: { code: 'COMMAND_FAILED', message: 'runner failed', hint: 'retry the open' },
          screen: { state: 'unavailable' },
        },
      },
    },
  });
});

test('test hosts native and Maestro sources format-neutrally and reports replay progress', async () => {
  const root = mkdtempForTestSync('agent-device-replay-application-suite-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const nativePath = path.join(root, '01-native.ad');
  const maestroPath = path.join(root, '02-maestro.yaml');
  fs.writeFileSync(nativePath, 'context platform=ios\nopen "Native"\n');
  fs.writeFileSync(maestroPath, 'appId: com.example.app\n---\n- launchApp\n- inputText: typed\n');
  const req = await withClientReplayScriptSources({
    token: 'token',
    session: 'default',
    command: 'test',
    positionals: [nativePath, maestroPath],
    flags: { platform: 'ios', replayBackend: 'maestro' },
    meta: { cwd: root, requestId: 'format-neutral-suite' },
  });
  const events: RequestProgressEvent[] = [];
  const invoked: DaemonRequest[] = [];

  const response = await withRequestProgressSink(
    (event) => events.push(event),
    async () =>
      await handleSessionReplayCommands(
        suiteParams(req, root, sessionStore, async (request) => {
          invoked.push(request);
          return request.command === 'snapshot'
            ? { ok: true, data: { createdAt: 0, nodes: [] } }
            : { ok: true, data: {} };
        }),
      ),
  );

  expect(response).toMatchObject({ ok: true, data: { total: 2, executed: 2, passed: 2 } });
  expect(
    invoked.filter(({ command }) => command !== 'snapshot').map(({ command }) => command),
  ).toEqual(['open', 'open', 'type']);
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'replay-test-suite', status: 'start', total: 2 }),
      expect.objectContaining({ type: 'replay-test', status: 'progress', stepIndex: 1 }),
      expect.objectContaining({ type: 'replay-test', status: 'pass' }),
    ]),
  );
});

test('test stops after an active cancellation and does not start the next replay', async () => {
  const root = mkdtempForTestSync('agent-device-replay-application-cancel-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const firstPath = writeReplayFile(root, ['open "First"']);
  const secondPath = path.join(root, 'second.ad');
  fs.writeFileSync(secondPath, 'open "Second"\n');
  const requestId = 'application-cancel';
  const req = await withClientReplayScriptSources({
    token: 'token',
    session: 'default',
    command: 'test',
    positionals: [firstPath, secondPath],
    meta: { cwd: root, requestId },
  });
  const invoked: DaemonRequest[] = [];

  registerRequestAbort(requestId);
  try {
    const response = await handleSessionReplayCommands(
      suiteParams(req, root, sessionStore, async (request) => {
        invoked.push(request);
        markRequestCanceled(requestId);
        return {
          ok: false,
          error: { code: 'COMMAND_FAILED', message: 'request canceled' },
        };
      }),
    );

    expect(response).toMatchObject({
      ok: true,
      data: { total: 2, executed: 1, failed: 1, notRun: 1 },
    });
    expect(invoked).toHaveLength(1);
  } finally {
    clearRequestCanceled(requestId);
  }
});
