import type { CommandFlags } from '@agent-device/contracts/command';
import { beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { buildSnapshotPresentationKey } from '@agent-device/kernel/snapshot';
import { handleInteractionCommands } from '../interaction.ts';
import { handleSnapshotCommands } from '../snapshot.ts';
import { dispatchCommand } from '../../../core/dispatch.ts';
import {
  makeIosSession,
  authoringPublication,
} from '../../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { SessionScriptWriter } from '../../session-script-writer.ts';
import { runReplayScriptSource } from '../session-replay-runtime.ts';
import { replayScriptSourceBundleFor } from '../../../__tests__/test-utils/replay-script-source.ts';
import {
  imageViewerNodes,
  profileNodes,
  snapshot,
  snapshotPayload,
} from './interaction-ios-tap-outcome-fixtures.ts';

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
  // Mirrors the production context builder (daemon/context.ts) for the fields
  // the corroboration capture path depends on.
  snapshotPreferredBackend: flags?.snapshotPreferredBackend,
});

async function runClick(
  sessionStore: ReturnType<typeof makeSessionStore>,
  sessionName: string,
  options: { positionals?: string[]; flags?: CommandFlags } = {},
): Promise<Awaited<ReturnType<typeof handleInteractionCommands>>> {
  return await handleInteractionCommands({
    req: {
      token: 'test',
      session: sessionName,
      command: 'click',
      positionals: options.positionals ?? ['id="unfollow"'],
      flags: options.flags ?? {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });
}

beforeEach(() => mockDispatch.mockReset());

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
    if (command === 'snapshot') return snapshotPayload(imageViewerNodes);
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
    if (command === 'snapshot') return snapshotPayload(profileNodes);
    return {};
  });

  const response = await runClick(sessionStore, sessionName);

  expect(response?.ok).toBe(false);
  if (response && !response.ok) expect(response.error.code).toBe('XCTEST_RECORDED_FAILURE');
  expect(sessionStore.get(sessionName)?.actions).toHaveLength(0);
});

test('a private-ax baseline pins the corroboration probe to private-ax', async () => {
  // The recorded-failure screens are exactly where the capture plan flips
  // between XCTest and private-AX (the penalty boundary). Without the pin, the
  // probe comes back on a different backend, the same-backend requirement
  // correctly refuses to compare, and a landed tap surfaces as a failure.
  const sessionName = 'ios-private-ax-pinned-corroboration';
  const sessionStore = makeSessionStore();
  sessionStore.set(
    sessionName,
    makeIosSession(sessionName, {
      appBundleId: 'com.example.app',
      snapshot: snapshot(profileNodes, 'private-ax'),
    }),
  );
  const snapshotContexts: Array<Record<string, unknown> | undefined> = [];
  mockDispatch.mockImplementation(async (_device, command, _positionals, _outPath, context) => {
    if (command === 'press') {
      throw new AppError(
        'XCTEST_RECORDED_FAILURE',
        'XCTest recorded a failure while executing tap; the action may not have been performed.',
      );
    }
    if (command === 'snapshot') {
      snapshotContexts.push(context as Record<string, unknown> | undefined);
      return snapshotPayload(imageViewerNodes, 'private-ax');
    }
    return {};
  });

  const response = await runClick(sessionStore, sessionName);

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.warning).toMatch(/post-action accessibility capture changed/);
  }
  expect(snapshotContexts).toHaveLength(1);
  expect(snapshotContexts[0]?.snapshotPreferredBackend).toBe('private-ax');
});

test('a raw baseline is excluded from corroboration entirely (#1634 P1)', async () => {
  // The raw diagnostic plan keeps tree-first error propagation by contract and
  // is never rerouted by the pin, so a raw private-AX baseline could not be
  // matched same-backend — corroboration must decline up front (no probe
  // capture at all) and the recorded failure surfaces unchanged.
  const sessionName = 'ios-raw-baseline-no-corroboration';
  const sessionStore = makeSessionStore();
  sessionStore.set(
    sessionName,
    makeIosSession(sessionName, {
      appBundleId: 'com.example.app',
      snapshot: snapshot(profileNodes, 'private-ax', { raw: true }),
    }),
  );
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'press') {
      throw new AppError(
        'XCTEST_RECORDED_FAILURE',
        'XCTest recorded a failure while executing tap; the action may not have been performed.',
      );
    }
    if (command === 'snapshot') return snapshotPayload(imageViewerNodes, 'private-ax');
    return {};
  });

  const response = await runClick(sessionStore, sessionName);

  expect(response?.ok).toBe(false);
  if (response && !response.ok) expect(response.error.code).toBe('XCTEST_RECORDED_FAILURE');
  // Declined before any probe: no corroboration snapshot was dispatched.
  expect(mockDispatch.mock.calls.filter((call) => call[1] === 'snapshot')).toHaveLength(0);
});

test('a tree baseline does not pin the corroboration probe backend', async () => {
  const sessionName = 'ios-tree-baseline-unpinned-corroboration';
  const sessionStore = makeSessionStore();
  sessionStore.set(
    sessionName,
    makeIosSession(sessionName, {
      appBundleId: 'com.example.app',
      snapshot: snapshot(profileNodes),
    }),
  );
  const snapshotContexts: Array<Record<string, unknown> | undefined> = [];
  mockDispatch.mockImplementation(async (_device, command, _positionals, _outPath, context) => {
    if (command === 'press') {
      throw new AppError(
        'XCTEST_RECORDED_FAILURE',
        'XCTest recorded a failure while executing tap; the action may not have been performed.',
      );
    }
    if (command === 'snapshot') {
      snapshotContexts.push(context as Record<string, unknown> | undefined);
      return snapshotPayload(imageViewerNodes);
    }
    return {};
  });

  const response = await runClick(sessionStore, sessionName);

  expect(response?.ok).toBe(true);
  expect(snapshotContexts).toHaveLength(1);
  expect(snapshotContexts[0]?.snapshotPreferredBackend).toBeUndefined();
});

test('a changed capture from a different iOS backend keeps the tap failure', async () => {
  const sessionName = 'ios-cross-backend-tap-corroboration';
  const sessionStore = makeSessionStore();
  sessionStore.set(
    sessionName,
    makeIosSession(sessionName, {
      appBundleId: 'com.example.app',
      snapshot: snapshot(profileNodes),
    }),
  );
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'press') {
      throw new AppError(
        'XCTEST_RECORDED_FAILURE',
        'XCTest recorded a failure while executing tap; the action may not have been performed.',
      );
    }
    if (command === 'snapshot') return snapshotPayload(imageViewerNodes, 'private-ax');
    return {};
  });

  const response = await runClick(sessionStore, sessionName);

  expect(response?.ok).toBe(false);
  if (response && !response.ok) expect(response.error.code).toBe('XCTEST_RECORDED_FAILURE');
  expect(sessionStore.get(sessionName)?.actions).toHaveLength(0);
});

test('a sparse changed capture keeps the tap failure', async () => {
  const sessionName = 'ios-sparse-tap-corroboration';
  const sessionStore = makeSessionStore();
  sessionStore.set(
    sessionName,
    makeIosSession(sessionName, {
      appBundleId: 'com.example.app',
      snapshot: snapshot(profileNodes),
    }),
  );
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'press') {
      throw new AppError(
        'XCTEST_RECORDED_FAILURE',
        'XCTest recorded a failure while executing tap; the action may not have been performed.',
      );
    }
    if (command === 'snapshot') {
      return {
        ...snapshotPayload(imageViewerNodes),
        quality: { state: 'sparse', backend: 'tree', reason: 'capture incomplete' },
      };
    }
    return {};
  });

  const response = await runClick(sessionStore, sessionName);

  expect(response?.ok).toBe(false);
  if (response && !response.ok) expect(response.error.code).toBe('XCTEST_RECORDED_FAILURE');
  expect(sessionStore.get(sessionName)?.actions).toHaveLength(0);
});

test('a corroboration capture failure keeps the tap failure', async () => {
  const sessionName = 'ios-capture-failed-tap-corroboration';
  const sessionStore = makeSessionStore();
  sessionStore.set(
    sessionName,
    makeIosSession(sessionName, {
      appBundleId: 'com.example.app',
      snapshot: snapshot(profileNodes),
    }),
  );
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'press') {
      throw new AppError(
        'XCTEST_RECORDED_FAILURE',
        'XCTest recorded a failure while executing tap; the action may not have been performed.',
      );
    }
    if (command === 'snapshot') throw new Error('forced corroboration capture failure');
    return {};
  });

  const response = await runClick(sessionStore, sessionName);

  expect(response?.ok).toBe(false);
  if (response && !response.ok) expect(response.error.code).toBe('XCTEST_RECORDED_FAILURE');
  expect(sessionStore.get(sessionName)?.actions).toHaveLength(0);
});

test('a changed capture with a different presentation keeps the tap failure', async () => {
  const sessionName = 'ios-presentation-mismatch-tap-corroboration';
  const sessionStore = makeSessionStore();
  const baseline = snapshot(profileNodes);
  baseline.presentationKey = 'unreadable-presentation';
  sessionStore.set(
    sessionName,
    makeIosSession(sessionName, {
      appBundleId: 'com.example.app',
      snapshot: baseline,
    }),
  );
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'press') {
      throw new AppError(
        'XCTEST_RECORDED_FAILURE',
        'XCTest recorded a failure while executing tap; the action may not have been performed.',
      );
    }
    if (command === 'snapshot') return snapshotPayload(imageViewerNodes);
    return {};
  });

  const response = await runClick(sessionStore, sessionName);

  expect(response?.ok).toBe(false);
  if (response && !response.ok) expect(response.error.code).toBe('XCTEST_RECORDED_FAILURE');
  expect(sessionStore.get(sessionName)?.actions).toHaveLength(0);
});

test('corroborates a tap when the request carries no flags and the baseline used a non-default scope', async () => {
  const sessionName = 'ios-no-flags-tap-corroboration';
  const sessionStore = makeSessionStore();
  const baseline = snapshot(profileNodes);
  baseline.presentationKey = buildSnapshotPresentationKey({ depth: 2, raw: false });
  sessionStore.set(
    sessionName,
    makeIosSession(sessionName, {
      appBundleId: 'com.example.app',
      snapshot: baseline,
    }),
  );
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'press') {
      throw new AppError(
        'XCTEST_RECORDED_FAILURE',
        'XCTest recorded a failure while executing tap; the action may not have been performed.',
      );
    }
    if (command === 'snapshot') return snapshotPayload(imageViewerNodes);
    return {};
  });

  // Deliberately built without a `flags` key at all (not `flags: {}`) — this
  // mirrors the raw daemon/JSON-RPC production boundary, which can omit the
  // key entirely. CLI and batch paths always materialize a flags object.
  const response = await handleInteractionCommands({
    req: {
      token: 'test',
      session: sessionName,
      command: 'click',
      positionals: ['id="unfollow"'],
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.warning).toMatch(/post-action accessibility capture changed/);
    expect(response.data?.selector).toBe('id="unfollow"');
  }
  expect(sessionStore.get(sessionName)?.actions).toHaveLength(1);
});

test('a changed capture after ordinary agent turn latency still corroborates the tap', async () => {
  const sessionName = 'ios-agent-turn-latency-corroboration';
  const sessionStore = makeSessionStore();
  const baseline = snapshot(profileNodes);
  baseline.createdAt = Date.now() - 6_000;
  sessionStore.set(
    sessionName,
    makeIosSession(sessionName, {
      appBundleId: 'com.example.app',
      snapshot: baseline,
    }),
  );
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'press') {
      throw new AppError(
        'XCTEST_RECORDED_FAILURE',
        'XCTest recorded a failure while executing tap; the action may not have been performed.',
      );
    }
    if (command === 'snapshot') return snapshotPayload(imageViewerNodes);
    return {};
  });

  const response = await runClick(sessionStore, sessionName);

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.warning).toMatch(/post-action accessibility capture changed/);
  }
  expect(mockDispatch.mock.calls.filter((call) => call[1] === 'snapshot')).toHaveLength(1);
  expect(sessionStore.get(sessionName)?.actions).toHaveLength(1);
});

test('a changed capture against a stale baseline keeps the tap failure', async () => {
  const sessionName = 'ios-stale-baseline-tap-corroboration';
  const sessionStore = makeSessionStore();
  const baseline = snapshot(profileNodes);
  baseline.createdAt = Date.now() - 15_001;
  sessionStore.set(
    sessionName,
    makeIosSession(sessionName, {
      appBundleId: 'com.example.app',
      snapshot: baseline,
    }),
  );
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'press') {
      throw new AppError(
        'XCTEST_RECORDED_FAILURE',
        'XCTest recorded a failure while executing tap; the action may not have been performed.',
      );
    }
    if (command === 'snapshot') return snapshotPayload(imageViewerNodes);
    return {};
  });

  const response = await runClick(sessionStore, sessionName);

  expect(response?.ok).toBe(false);
  if (response && !response.ok) expect(response.error.code).toBe('XCTEST_RECORDED_FAILURE');
  expect(mockDispatch.mock.calls.filter((call) => call[1] === 'snapshot')).toHaveLength(0);
  expect(sessionStore.get(sessionName)?.actions).toHaveLength(0);
});

test('a changed capture against a keyless baseline keeps the tap failure', async () => {
  const sessionName = 'ios-keyless-baseline-tap-corroboration';
  const sessionStore = makeSessionStore();
  const baseline = snapshot(profileNodes);
  baseline.presentationKey = undefined;
  sessionStore.set(
    sessionName,
    makeIosSession(sessionName, {
      appBundleId: 'com.example.app',
      snapshot: baseline,
    }),
  );
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'press') {
      throw new AppError(
        'XCTEST_RECORDED_FAILURE',
        'XCTest recorded a failure while executing tap; the action may not have been performed.',
      );
    }
    if (command === 'snapshot') return snapshotPayload(imageViewerNodes);
    return {};
  });

  const response = await runClick(sessionStore, sessionName);

  expect(response?.ok).toBe(false);
  if (response && !response.ok) expect(response.error.code).toBe('XCTEST_RECORDED_FAILURE');
  expect(mockDispatch.mock.calls.filter((call) => call[1] === 'snapshot')).toHaveLength(0);
  expect(sessionStore.get(sessionName)?.actions).toHaveLength(0);
});

test('runtime-resolved taps use the same corroboration boundary', async () => {
  const sessionName = 'ios-runtime-tap-corroboration';
  const sessionStore = makeSessionStore();
  sessionStore.set(
    sessionName,
    makeIosSession(sessionName, {
      appBundleId: 'com.example.app',
      scriptPublication: authoringPublication('armed'),
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
      return snapshotPayload(snapshotCount === 1 ? profileNodes : imageViewerNodes);
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

test('a corroborated runtime coordinate tap does not schedule a no-change retry', async () => {
  const sessionName = 'ios-runtime-coordinate-corroboration';
  const sessionStore = makeSessionStore();
  sessionStore.set(
    sessionName,
    makeIosSession(sessionName, {
      appBundleId: 'com.example.app',
      snapshot: snapshot(profileNodes),
    }),
  );
  let pressCount = 0;
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'press') {
      pressCount += 1;
      if (pressCount === 1) {
        throw new AppError(
          'XCTEST_RECORDED_FAILURE',
          'XCTest recorded a failure while executing tap; the action may not have been performed.',
        );
      }
      return {};
    }
    if (command === 'snapshot') return snapshotPayload(imageViewerNodes);
    return {};
  });

  const clickResponse = await runClick(sessionStore, sessionName, {
    positionals: ['104', '222'],
    flags: { interactionOutcome: { retryOnNoChange: true } },
  });
  expect(clickResponse?.ok).toBe(true);
  if (clickResponse?.ok) {
    expect(clickResponse.data?.warning).toMatch(/post-action accessibility capture changed/);
  }

  const snapshotResponse = await handleSnapshotCommands({
    req: {
      token: 'test',
      session: sessionName,
      command: 'snapshot',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(snapshotResponse?.ok).toBe(true);
  expect(pressCount).toBe(1);
  expect(sessionStore.get(sessionName)?.pendingInteractionOutcome).toBeUndefined();
});

test('corroborated runtime taps retain target evidence through save and replay', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-ios-tap-replay-'));
  const sessionName = 'ios-recorded-tap';
  const sessionStore = makeSessionStore();
  sessionStore.set(
    sessionName,
    makeIosSession(sessionName, {
      appBundleId: 'com.example.app',
      scriptPublication: authoringPublication('armed'),
      snapshot: snapshot(profileNodes),
    }),
  );
  let recording = true;
  let snapshotCount = 0;
  let pressCount = 0;
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'press') {
      pressCount += 1;
      if (recording) {
        throw new AppError(
          'XCTEST_RECORDED_FAILURE',
          'XCTest recorded a failure while executing tap; the action may not have been performed.',
        );
      }
      return {};
    }
    if (command === 'snapshot') {
      snapshotCount += 1;
      return snapshotPayload(recording && snapshotCount === 2 ? imageViewerNodes : profileNodes);
    }
    return {};
  });

  const recordedResponse = await runClick(sessionStore, sessionName);
  expect(recordedResponse?.ok).toBe(true);
  const recordedAction = sessionStore.get(sessionName)?.actions[0];
  expect(recordedAction?.result?.selectorChain).toEqual([
    'id="unfollow"',
    'role="button" label="Unfollow"',
    'label="Unfollow"',
  ]);
  expect(recordedAction?.targetEvidence).toBeDefined();

  const written = new SessionScriptWriter(path.join(root, 'sessions')).write(
    sessionStore.get(sessionName)!,
  );
  expect(written.written).toBe(true);
  if (!written.written) return;
  const savedScript = fs.readFileSync(written.path, 'utf8');
  expect(savedScript).toContain('# agent-device:target-v1');
  expect(savedScript).toContain(
    'click "id=\\"unfollow\\" || role=\\"button\\" label=\\"Unfollow\\" || label=\\"Unfollow\\""',
  );

  recording = false;
  const replaySessionName = 'ios-replayed-tap';
  const replayStore = makeSessionStore();
  replayStore.set(
    replaySessionName,
    makeIosSession(replaySessionName, {
      appBundleId: 'com.example.app',
      snapshot: snapshot(profileNodes),
    }),
  );
  const replayResponse = await runReplayScriptSource({
    req: {
      token: 'test',
      session: replaySessionName,
      command: 'replay',
      positionals: [written.path],
      flags: {
        replayKeepSession: true,
        replayScriptSource: replayScriptSourceBundleFor(written.path),
      },
    },
    sessionName: replaySessionName,
    logPath: path.join(root, 'replay-daemon.log'),
    sessionStore: replayStore,
    invoke: async (req) => {
      const response = await handleInteractionCommands({
        req,
        sessionName: replaySessionName,
        sessionStore: replayStore,
        contextFromFlags,
      });
      if (!response) throw new Error(`unexpected empty response for ${req.command}`);
      return response;
    },
  });

  expect(replayResponse.ok).toBe(true);
  expect(pressCount).toBe(2);
  expect(snapshotCount).toBeGreaterThanOrEqual(4);
});
