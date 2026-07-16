import { test, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleInteractionCommands } from '../interaction.ts';
import { attachRefs, type RawSnapshotNode } from '../../../kernel/snapshot.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import { SessionScriptWriter } from '../../session-script-writer.ts';
import type { CommandFlags } from '../../../core/dispatch.ts';
import type { SessionState } from '../../types.ts';

// ADR 0012 decision 3, daemon-routed recording: target-v1 evidence is
// computed only while the session is being recorded, lands on the recorded
// action (never the public response), and the raw resolved node/tree reaches
// neither the client nor session history. Covers the touch path
// (finalizeTouchInteraction) and the get path (recordIfSession), including
// the recording gate on the direct-iOS get fast path.

const { mockRunAppleRunnerCommand } = vi.hoisted(() => ({
  mockRunAppleRunnerCommand: vi.fn(),
}));

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchCommand: vi.fn(async () => ({})),
  };
});

vi.mock('../../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/runner/runner-client.ts')>();
  return {
    ...actual,
    runAppleRunnerCommand: mockRunAppleRunnerCommand,
  };
});

import { dispatchCommand } from '../../../core/dispatch.ts';
const mockDispatch = vi.mocked(dispatchCommand);

const contextFromFlags = (_flags: CommandFlags | undefined) => ({});

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({});
  mockRunAppleRunnerCommand.mockReset();
  mockRunAppleRunnerCommand.mockResolvedValue({});
});

const SAVE_BUTTON_NODES: RawSnapshotNode[] = [
  {
    index: 0,
    type: 'XCUIElementTypeButton',
    identifier: 'save',
    label: 'Save',
    rect: { x: 10, y: 20, width: 100, height: 40 },
    enabled: true,
    hittable: true,
  },
];

function makeSessionWithSnapshot(
  sessionName: string,
  options: { recordSession: boolean },
): SessionState {
  const session = makeIosSession(sessionName, { appBundleId: 'com.example.app' });
  session.recordSession = options.recordSession;
  session.snapshot = {
    nodes: attachRefs(SAVE_BUTTON_NODES),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  return session;
}

async function runCommand(
  sessionStore: ReturnType<typeof makeSessionStore>,
  sessionName: string,
  command: string,
  positionals: string[],
  flags: CommandFlags = {},
) {
  return await handleInteractionCommands({
    req: { token: 't', session: sessionName, command, positionals, flags },
    sessionName,
    sessionStore,
    contextFromFlags,
  });
}

test('press @ref while recording attaches target-v1 evidence to the recorded action, never to the public response', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'recording-press';
  sessionStore.set(sessionName, makeSessionWithSnapshot(sessionName, { recordSession: true }));

  // verify:true forces full runtime resolution, which captures node/tree.
  const response = await runCommand(sessionStore, sessionName, 'press', ['@e1'], { verify: true });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data).not.toHaveProperty('node');
    expect(response.data).not.toHaveProperty('preActionNodes');
    expect(response.data).not.toHaveProperty('targetEvidence');
  }

  const recordedAction = sessionStore.get(sessionName)?.actions[0];
  expect(recordedAction?.targetEvidence).toEqual({
    id: 'save',
    role: 'button',
    label: 'Save',
    ancestry: [],
    sibling: 0,
    viewportOrder: 0,
    rect: { x: 10, y: 20, width: 100, height: 40 },
    verification: 'verified',
  });
  expect(recordedAction?.result).not.toHaveProperty('node');
  expect(recordedAction?.result).not.toHaveProperty('preActionNodes');
});

test('press @ref without recording never computes target-v1 evidence', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'non-recording-press';
  sessionStore.set(sessionName, makeSessionWithSnapshot(sessionName, { recordSession: false }));

  const response = await runCommand(sessionStore, sessionName, 'press', ['@e1'], { verify: true });

  expect(response?.ok).toBe(true);
  const recordedAction = sessionStore.get(sessionName)?.actions[0];
  expect(recordedAction?.targetEvidence).toBeUndefined();
  expect(recordedAction?.result).not.toHaveProperty('node');
  expect(recordedAction?.result).not.toHaveProperty('preActionNodes');
});

test('get text @ref while recording attaches target-v1 evidence to the recorded action, never to session history payloads', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'recording-get-ref';
  sessionStore.set(sessionName, makeSessionWithSnapshot(sessionName, { recordSession: true }));

  const response = await runCommand(sessionStore, sessionName, 'get', ['text', '@e1']);

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data).not.toHaveProperty('preActionNodes');
    expect(response.data).not.toHaveProperty('targetEvidence');
  }

  const recordedAction = sessionStore.get(sessionName)?.actions[0];
  expect(recordedAction?.targetEvidence).toEqual({
    id: 'save',
    role: 'button',
    label: 'Save',
    ancestry: [],
    sibling: 0,
    viewportOrder: 0,
    rect: { x: 10, y: 20, width: 100, height: 40 },
    verification: 'verified',
  });
  expect(recordedAction?.result).not.toHaveProperty('node');
  expect(recordedAction?.result).not.toHaveProperty('preActionNodes');
});

test('get text @ref without recording never computes target-v1 evidence', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'non-recording-get-ref';
  sessionStore.set(sessionName, makeSessionWithSnapshot(sessionName, { recordSession: false }));

  const response = await runCommand(sessionStore, sessionName, 'get', ['text', '@e1']);

  expect(response?.ok).toBe(true);
  const recordedAction = sessionStore.get(sessionName)?.actions[0];
  expect(recordedAction?.targetEvidence).toBeUndefined();
});

test('get text simple iOS id selector while recording skips the direct runner query and records evidence from the snapshot path', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'recording-get-direct-gate';
  const session = makeIosSession(sessionName, { appBundleId: 'com.example.app' });
  session.recordSession = true;
  sessionStore.set(sessionName, session);
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'snapshot') {
      return {
        backend: 'xctest',
        nodes: [
          {
            index: 0,
            depth: 0,
            type: 'Application',
            rect: { x: 0, y: 0, width: 393, height: 852 },
            enabled: true,
            hittable: true,
          },
          {
            index: 1,
            depth: 1,
            parentIndex: 0,
            type: 'TextField',
            label: 'Name',
            identifier: 'field-name',
            value: 'Ada Lovelace',
            rect: { x: 24, y: 220, width: 320, height: 48 },
            enabled: true,
            hittable: true,
          },
        ],
      };
    }
    return {};
  });

  const response = await runCommand(sessionStore, sessionName, 'get', ['text', 'id="field-name"']);

  expect(response?.ok).toBe(true);
  // The direct-iOS querySelector fast path must be gated during recording so
  // the snapshot path supplies the evidence tree.
  expect(mockRunAppleRunnerCommand).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ command: 'querySelector' }),
    expect.anything(),
  );
  expect(mockDispatch.mock.calls.map((call) => call[1])).toContain('snapshot');

  const recordedAction = sessionStore.get(sessionName)?.actions[0];
  expect(recordedAction?.targetEvidence).toMatchObject({
    id: 'field-name',
    role: 'textfield',
    label: 'Name',
    ancestry: [{ role: 'application' }],
    verification: 'verified',
  });
});

// ---------------------------------------------------------------------------
// #1280 (ADR 0012 decision 3 amendment), the recording-boundary split: a
// press on an identity-empty container retargets ONLY what gets recorded.
// The daemon RESPONSE stays entirely container-based (chain, hittability, no
// side-channel leak), while the recorded action entry (the .ad writer's
// source) and its target-v1 evidence are descendant-based.
// ---------------------------------------------------------------------------

const IDENTITY_EMPTY_ROW_NODES: RawSnapshotNode[] = [
  {
    index: 0,
    depth: 0,
    type: 'FrameLayout',
    rect: { x: 0, y: 0, width: 400, height: 800 },
    enabled: true,
    hittable: true,
  },
  {
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: 'LinearLayout',
    rect: { x: 0, y: 100, width: 300, height: 48 },
    enabled: true,
    hittable: true,
  },
  {
    index: 2,
    depth: 2,
    parentIndex: 1,
    type: 'TextView',
    label: 'Connected devices',
    rect: { x: 0, y: 100, width: 300, height: 48 },
    enabled: true,
    hittable: false,
  },
];

// The wire response describes the dispatched CONTAINER, and the
// recording-only side channel never leaks into it.
function expectContainerBasedResponse(data: Record<string, unknown>): void {
  expect(data.selectorChain).toEqual(['role="linearlayout"']);
  expect(data.targetHittable).toBeUndefined();
  expect(data).not.toHaveProperty('recordingTarget');
  expect(data).not.toHaveProperty('node');
  expect(data).not.toHaveProperty('preActionNodes');
}

// The recorded action entry — the .ad writer's source — carries the
// DESCENDANT chain/ref-label, and its target-v1 evidence names the same
// descendant (role+label; the container has no selective identity).
function expectDescendantBasedRecording(session: SessionState): void {
  const recordedAction = session.actions[0];
  if (!recordedAction) throw new Error('expected a recorded action');
  expect(recordedAction.result?.selectorChain).toEqual([
    'role="textview" label="Connected devices"',
    'label="Connected devices"',
  ]);
  expect(recordedAction.result?.refLabel).toBe('Connected devices');
  expect(recordedAction.result).not.toHaveProperty('recordingTarget');
  expect(recordedAction.targetEvidence).toMatchObject({
    role: 'textview',
    label: 'Connected devices',
    verification: 'verified',
  });
  expect(recordedAction.targetEvidence?.id).toBeUndefined();
}

function writeSessionScript(session: SessionState): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-press-retarget-'));
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const written = writer.write(session);
  if (!written.written) throw new Error('expected the script to be written');
  return fs.readFileSync(written.path, 'utf8');
}

test('press on an identity-empty container: container-based daemon response, descendant-based recorded entry + .ad script', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'recording-press-retarget';
  // The fixture is the measured Android list-row shape, but the recording
  // boundary under test is platform-independent — an iOS session keeps this
  // on the runtime resolution path (the direct-iOS fast path is gated during
  // recording) without Android's real-adb dialog-readiness probes, which
  // would burn wall-clock time this unit lane must not spend.
  const session = makeIosSession(sessionName, { appBundleId: 'com.example.app' });
  session.recordSession = true;
  sessionStore.set(sessionName, session);
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'snapshot') {
      return { backend: 'xctest', nodes: IDENTITY_EMPTY_ROW_NODES };
    }
    return {};
  });

  const response = await runCommand(sessionStore, sessionName, 'press', ['role=linearlayout']);

  expect(response?.ok).toBe(true);
  if (!response?.ok || !response.data) throw new Error('expected an ok response with data');
  expectContainerBasedResponse(response.data);

  const recordedSession = sessionStore.get(sessionName);
  if (!recordedSession) throw new Error('expected the session to persist');
  expectDescendantBasedRecording(recordedSession);

  // And the WRITTEN .ad line re-resolves the descendant, not the container.
  const script = writeSessionScript(recordedSession);
  expect(script).toContain(
    'press "role=\\"textview\\" label=\\"Connected devices\\" || label=\\"Connected devices\\""',
  );
  expect(script).toContain('"role":"textview","label":"Connected devices"');
});
