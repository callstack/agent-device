import type { CommandFlags } from '@agent-device/contracts/command';
import type {
  DaemonGetResult,
  DaemonIsResult,
} from '@agent-device/contracts/daemon-command-surface';
import { buildSelectorChainForNode } from '@agent-device/selectors';
import { legacyDispatchCapture } from '../__tests__/support/legacy-snapshot-capture-fixture.ts';
import { test, expect, beforeEach } from 'vitest';
import { handleInteractionCommands } from './interaction/index.ts';
import type { RawSnapshotNode, SnapshotNode } from '@agent-device/kernel/snapshot';
import { makeSessionStore } from '../__tests__/support/store-factory.ts';
import { makeAuthoringSession } from '../__tests__/support/session-factories.ts';
import { installLegacyCaptureInteractorResolution } from '../__tests__/support/legacy-capture-interactor-resolution.ts';
import {
  captureAndStoreSnapshot,
  commandSurfaceWithMembers,
} from '../__tests__/support/command-surface-override-fake.ts';
import {
  SAVE_BUTTON_EVIDENCE,
  SAVE_BUTTON_NODES,
  makeSessionWithSaveButtonSnapshot,
} from '../__tests__/support/target-evidence-fixture.ts';
import {
  getRuntimeBindings,
  resetGetRuntimeFixture,
} from './__tests__/interaction-get-runtime-fixture.ts';

// ADR 0012 decision 3 / #1349, daemon-routed recording of the get path (recordIfSession): the
// target-v1 evidence is computed only while the session is being recorded, lands on the recorded
// action (never the public response), and the raw resolved node/tree reaches neither the client nor
// session history. The touch path is pinned in
// execution/interaction/internal/interaction-target-evidence.test.ts.

installLegacyCaptureInteractorResolution();

const contextFromFlags = (_flags: CommandFlags | undefined) => ({});

beforeEach(() => {
  legacyDispatchCapture.mockReset();
  legacyDispatchCapture.mockResolvedValue({});
  resetGetRuntimeFixture();
});

const LABEL_OR_ID = /^(label|id)="?([^"]*)"?$/;

function findNode(nodes: SnapshotNode[], selector: string): SnapshotNode | undefined {
  const [, key, value] = LABEL_OR_ID.exec(selector) ?? [];
  return nodes.find((node) => (key === 'id' ? node.identifier : node.label) === value);
}

/**
 * The command family's `get` and `is`, answering with the resolution payload (`node`,
 * `preActionNodes`) the daemon records evidence from: a `@ref` reads the stored tree, a selector
 * reads a capture taken through the config's backend and stored as the session snapshot.
 */
const selectorReadSurface = commandSurfaceWithMembers((config) => {
  const read = async (selector: string, session: string | undefined) => {
    const { nodes } = await captureAndStoreSnapshot(config, {
      session,
      includeRects: true,
    });
    return { nodes, node: findNode(nodes, selector) };
  };
  return {
    selectors: {
      get: async (options): Promise<DaemonGetResult> => {
        const { target } = options;
        const record = await config.sessions?.get(options.session ?? 'default');
        const resolved =
          target.kind === 'ref'
            ? {
                nodes: record?.snapshot?.nodes ?? [],
                node: record?.snapshot?.nodes.find(
                  (candidate) => candidate.ref === target.ref.replace(/^@/, ''),
                ),
              }
            : await read(target.selector, options.session);
        if (!resolved.node) throw new Error('get: the target resolved to no node');
        return {
          kind: 'text',
          target,
          text: resolved.node.label ?? '',
          node: resolved.node,
          selectorChain: buildSelectorChainForNode(resolved.node, config.backend.platform, {
            action: 'get',
            nodes: resolved.nodes,
          }),
          preActionNodes: resolved.nodes,
        } as DaemonGetResult;
      },
      is: async (options): Promise<DaemonIsResult> => {
        const { nodes, node } = await read(options.selector, options.session);
        if (options.predicate === 'absent') {
          return {
            predicate: 'absent',
            pass: true,
            selector: options.selector,
            matches: nodes.filter((candidate) => candidate === node).length,
          };
        }
        if (!node) throw new Error('is: the selector resolved to no node');
        if (options.predicate === 'exists') {
          return { predicate: 'exists', pass: true, selector: options.selector, matches: 1 };
        }
        return {
          predicate: options.predicate,
          pass: true,
          selector: options.selector,
          selectorChain: buildSelectorChainForNode(node, config.backend.platform, { nodes }),
          node,
          preActionNodes: nodes,
        };
      },
    },
  };
});

async function runCommand(
  sessionStore: ReturnType<typeof makeSessionStore>,
  sessionName: string,
  command: string,
  positionals: string[],
) {
  return await handleInteractionCommands({
    createCommandSurface: selectorReadSurface,
    req: { token: 't', session: sessionName, command, positionals, flags: {} },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });
}

test('get text @ref while recording attaches target-v1 evidence to the recorded action, never to session history payloads', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'recording-get-ref';
  sessionStore.publish(
    sessionName,
    makeSessionWithSaveButtonSnapshot(sessionName, { recording: true }),
  );

  const response = await runCommand(sessionStore, sessionName, 'get', ['text', '@e1']);

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data).not.toHaveProperty('preActionNodes');
    expect(response.data).not.toHaveProperty('targetEvidence');
  }

  const recordedAction = sessionStore.get(sessionName)?.actions[0];
  expect(recordedAction?.targetEvidence).toEqual(SAVE_BUTTON_EVIDENCE);
  expect(recordedAction?.result).not.toHaveProperty('node');
  expect(recordedAction?.result).not.toHaveProperty('preActionNodes');
});

test('get text @ref without recording never computes target-v1 evidence', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'non-recording-get-ref';
  sessionStore.publish(
    sessionName,
    makeSessionWithSaveButtonSnapshot(sessionName, { recording: false }),
  );

  const response = await runCommand(sessionStore, sessionName, 'get', ['text', '@e1']);

  expect(response?.ok).toBe(true);
  const recordedAction = sessionStore.get(sessionName)?.actions[0];
  expect(recordedAction?.targetEvidence).toBeUndefined();
});

test('get text simple iOS id selector while recording records evidence from the snapshot path', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'recording-get-direct-gate';
  const session = makeAuthoringSession(sessionName, { appBundleId: 'com.example.app' });
  sessionStore.publish(sessionName, session);
  legacyDispatchCapture.mockImplementation(async (_device, command) => {
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
  // The snapshot path supplies the evidence tree.
  expect(legacyDispatchCapture.mock.calls.map((call) => call[1])).toContain('snapshot');

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
// #1349: `is` joins the evidence-carrying set (get-pattern) — a unique-
// resolving predicate records target-v1 evidence while recording; `is exists`
// stays intentionally unannotated; the snapshot path supplies the evidence tree.
// ---------------------------------------------------------------------------

function mockSnapshotWithSaveButton() {
  legacyDispatchCapture.mockImplementation(async (_device, command) => {
    if (command === 'snapshot') {
      return { backend: 'xctest', nodes: SAVE_BUTTON_NODES as RawSnapshotNode[] };
    }
    return {};
  });
}

test('is visible while recording attaches target-v1 evidence and strips the resolution payload everywhere', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'recording-is';
  sessionStore.publish(
    sessionName,
    makeSessionWithSaveButtonSnapshot(sessionName, { recording: true }),
  );
  mockSnapshotWithSaveButton();

  const response = await runCommand(sessionStore, sessionName, 'is', ['visible', 'label="Save"']);

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data).not.toHaveProperty('node');
    expect(response.data).not.toHaveProperty('preActionNodes');
    expect(response.data).not.toHaveProperty('selectorChain');
  }

  const recordedAction = sessionStore.get(sessionName)?.actions[0];
  expect(recordedAction?.targetEvidence).toMatchObject({
    id: 'save',
    role: 'button',
    label: 'Save',
    verification: 'verified',
  });
  expect(recordedAction?.result).not.toHaveProperty('node');
  expect(recordedAction?.result).not.toHaveProperty('preActionNodes');
});

test('is exists while recording stays intentionally unannotated (deferred coverage)', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'recording-is-exists';
  sessionStore.publish(
    sessionName,
    makeSessionWithSaveButtonSnapshot(sessionName, { recording: true }),
  );
  mockSnapshotWithSaveButton();

  const response = await runCommand(sessionStore, sessionName, 'is', ['exists', 'label="Save"']);

  expect(response?.ok).toBe(true);
  const recordedAction = sessionStore.get(sessionName)?.actions[0];
  expect(recordedAction?.command).toBe('is');
  expect(recordedAction?.targetEvidence).toBeUndefined();
});

test('is absent while recording stays an ordinary unannotated observation', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'recording-is-absent';
  sessionStore.publish(
    sessionName,
    makeSessionWithSaveButtonSnapshot(sessionName, { recording: true }),
  );
  mockSnapshotWithSaveButton();

  const response = await runCommand(sessionStore, sessionName, 'is', [
    'absent',
    'label="Removed row"',
  ]);

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data).toEqual({
      predicate: 'absent',
      pass: true,
      selector: 'label="Removed row"',
      matches: 0,
    });
  }
  const recordedAction = sessionStore.get(sessionName)?.actions[0];
  expect(recordedAction?.command).toBe('is');
  expect(recordedAction?.targetEvidence).toBeUndefined();
  expect(recordedAction?.result).toEqual({
    predicate: 'absent',
    pass: true,
    selector: 'label="Removed row"',
    matches: 0,
  });
});

test('is visible without recording never computes target-v1 evidence', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'non-recording-is';
  sessionStore.publish(
    sessionName,
    makeSessionWithSaveButtonSnapshot(sessionName, { recording: false }),
  );
  mockSnapshotWithSaveButton();

  const response = await runCommand(sessionStore, sessionName, 'is', ['visible', 'label="Save"']);

  expect(response?.ok).toBe(true);
  const recordedAction = sessionStore.get(sessionName)?.actions[0];
  expect(recordedAction?.targetEvidence).toBeUndefined();
});
