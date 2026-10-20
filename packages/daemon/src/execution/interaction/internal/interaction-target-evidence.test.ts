import type { CommandFlags } from '@agent-device/contracts/command';
import { legacyDispatchCapture } from '../../../__tests__/support/legacy-snapshot-capture-fixture.ts';
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { handleInteractionCommands } from '../index.ts';
import { centerOfRect, type RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { makeSessionStore } from '../../../__tests__/support/store-factory.ts';
import { makeAuthoringSession } from '../../../__tests__/support/session-factories.ts';
import { SessionScriptWriter } from '../../../core/session-script-writer.ts';
import type { SessionState } from '../../../core/session-state.ts';
import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { installLegacyCaptureInteractorResolution } from '../../../__tests__/support/legacy-capture-interactor-resolution.ts';
import { captureAndStoreSnapshot } from '../../../__tests__/support/command-surface-override-fake.ts';
import {
  SAVE_BUTTON_EVIDENCE,
  makeSessionWithSaveButtonSnapshot,
} from '../../../__tests__/support/target-evidence-fixture.ts';
import { createTouchCommandSurface } from '../../../__tests__/support/touch-command-surface-fake.ts';
import {
  getRuntimeBindings,
  resetGetRuntimeFixture,
} from '../../__tests__/interaction-get-runtime-fixture.ts';

// ADR 0012 decision 3, daemon-routed recording of the touch path (finalizeTouchInteraction):
// target-v1 evidence is computed only while the session is being recorded, lands on the recorded
// action (never the public response), and the raw resolved node/tree reaches neither the client nor
// session history. The get/is recording path is pinned in
// execution/selector-runtime-target-evidence.test.ts.

installLegacyCaptureInteractorResolution();

const contextFromFlags = (_flags: CommandFlags | undefined) => ({});

beforeEach(() => {
  legacyDispatchCapture.mockReset();
  legacyDispatchCapture.mockResolvedValue({});
  resetGetRuntimeFixture();
});

async function runCommand(
  sessionStore: ReturnType<typeof makeSessionStore>,
  sessionName: string,
  command: string,
  positionals: string[],
  flags: CommandFlags = {},
  createCommandSurface = createTouchCommandSurface(),
) {
  return await handleInteractionCommands({
    createCommandSurface,
    req: { token: 't', session: sessionName, command, positionals, flags },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });
}

test('press @ref while recording attaches target-v1 evidence to the recorded action, never to the public response', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'recording-press';
  sessionStore.publish(
    sessionName,
    makeSessionWithSaveButtonSnapshot(sessionName, { recording: true }),
  );

  const response = await runCommand(sessionStore, sessionName, 'press', ['@e1'], { verify: true });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data).not.toHaveProperty('node');
    expect(response.data).not.toHaveProperty('preAction');
    expect(response.data).not.toHaveProperty('targetEvidence');
  }

  const recordedAction = sessionStore.get(sessionName)?.actions[0];
  expect(recordedAction?.targetEvidence).toEqual(SAVE_BUTTON_EVIDENCE);
  expect(recordedAction?.result).not.toHaveProperty('node');
  expect(recordedAction?.result).not.toHaveProperty('preAction');
});

test('press @ref without recording never computes target-v1 evidence', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'non-recording-press';
  sessionStore.publish(
    sessionName,
    makeSessionWithSaveButtonSnapshot(sessionName, { recording: false }),
  );

  const response = await runCommand(sessionStore, sessionName, 'press', ['@e1'], { verify: true });

  expect(response?.ok).toBe(true);
  const recordedAction = sessionStore.get(sessionName)?.actions[0];
  expect(recordedAction?.targetEvidence).toBeUndefined();
  expect(recordedAction?.result).not.toHaveProperty('node');
  expect(recordedAction?.result).not.toHaveProperty('preAction');
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

/**
 * The command family's answer for a press on that container: the response describes the dispatched
 * container, and the labeled descendant rides the recording-only `recordingTarget` side channel.
 */
const containerPressSurface = createTouchCommandSurface({
  members: (config) => ({
    interactions: {
      press: async (target, options) => {
        const { nodes } = await captureAndStoreSnapshot(config, {
          session: options?.session,
          interactiveOnly: true,
          includeRects: true,
        });
        const container = nodes[1]!;
        const point = centerOfRect(container.rect!);
        await config.backend.tap?.({ session: options?.session }, point);
        return {
          kind: 'selector',
          point,
          target: target as { kind: 'selector'; selector: string },
          node: container,
          selectorChain: ['role="linearlayout"'],
          preAction: { nodes },
          recordingTarget: {
            node: nodes[2]!,
            selectorChain: [
              'role="textview" label="Connected devices"',
              'label="Connected devices"',
            ],
            refLabel: 'Connected devices',
          },
        };
      },
    },
  }),
});

// The wire response describes the dispatched CONTAINER, and the
// recording-only side channel never leaks into it.
function expectContainerBasedResponse(data: Record<string, unknown>): void {
  expect(data.selectorChain).toEqual(['role="linearlayout"']);
  expect(data.targetHittable).toBeUndefined();
  expect(data).not.toHaveProperty('recordingTarget');
  expect(data).not.toHaveProperty('node');
  expect(data).not.toHaveProperty('preAction');
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
  const root = mkdtempForTestSync('agent-device-press-retarget-');
  const writer = new SessionScriptWriter(
    path.join(root, 'sessions'),
    createLiveTestHostEnvironment().cwd,
  );
  const written = writer.write(session);
  if (!written.written) throw new Error('expected the script to be written');
  return fs.readFileSync(written.path, 'utf8');
}

test('press on an identity-empty container: container-based daemon response, descendant-based recorded entry + .ad script', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'recording-press-retarget';
  const session = makeAuthoringSession(sessionName, { appBundleId: 'com.example.app' });
  sessionStore.publish(sessionName, session);
  legacyDispatchCapture.mockImplementation(async (_device, command) => {
    if (command === 'snapshot') {
      return { backend: 'xctest', nodes: IDENTITY_EMPTY_ROW_NODES };
    }
    return {};
  });

  const response = await runCommand(
    sessionStore,
    sessionName,
    'press',
    ['role=linearlayout'],
    {},
    containerPressSurface,
  );

  expect(response?.ok).toBe(true);
  if (!response?.ok || !response.data) throw new Error('expected an ok response with data');
  expectContainerBasedResponse(response.data);

  const recordedSession = sessionStore.get(sessionName);
  if (!recordedSession) throw new Error('expected the session to persist');
  expectDescendantBasedRecording(recordedSession);

  // And the WRITTEN .ad line re-resolves the descendant, not the container.
  const script = writeSessionScript(recordedSession);
  expect(script).toContain(
    String.raw`press "role=\"textview\" label=\"Connected devices\" || label=\"Connected devices\""`,
  );
  expect(script).toContain('"role":"textview","label":"Connected devices"');
});
