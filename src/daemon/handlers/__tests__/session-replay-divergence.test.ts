import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(async () => ({})), resolveTargetDevice: vi.fn() };
});

import { dispatchCommand } from '../../../core/dispatch.ts';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import { SessionStore } from '../../session-store.ts';
import { buildReplayFailureDivergence } from '../session-replay-divergence.ts';

const mockDispatchCommand = vi.mocked(dispatchCommand);

beforeEach(() => {
  mockDispatchCommand.mockReset();
  mockDispatchCommand.mockResolvedValue({});
});

test('buildReplayFailureDivergence dedupes suggestions using the strongest basis', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-suggest-dedupe-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));

  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        label: 'Save',
        identifier: 'save',
        rect: { x: 0, y: 0, width: 100, height: 44 },
        hittable: true,
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const action = {
    ts: 0,
    command: 'click',
    positionals: ['label="Save"'],
    flags: {},
    result: { selectorChain: ['label="Save"', 'id="save"'] },
  };
  const divergence = await buildReplayFailureDivergence({
    error: { code: 'COMMAND_FAILED', message: 'not hittable' },
    action,
    index: 0,
    sourcePath: path.join(root, 'flow.ad'),
    sourceLine: 1,
    session: sessionStore.get(sessionName),
    sessionName,
    sessionStore,
    logPath: path.join(root, 'daemon.log'),
    responseLevel: 'default',
    planActions: [action],
    planDigest: 'test-plan-digest',
  });

  expect(divergence.suggestionCount).toBe(1);
  expect(divergence.suggestions).toHaveLength(1);
  expect(divergence.suggestions[0]?.ref).toBe('e1');
  expect(divergence.suggestions[0]?.basis).toBe('id');
});

// Live-shape fixture (iPhone 17 Pro sim, iOS 26): the software keyboard
// renders in its own window ([Window] > [Keyboard] > 26 [Key] children).
// Onscreen, that subtree alone blows past SCREEN_REF_CAPTURE_LIMIT (20),
// which is exactly the bug: the real actionable target (a sibling of the
// keyboard window, not inside it) sorts after the keys in document order and
// gets truncated out unless keyboard/IME chrome is excluded from the budget
// first.
function keyboardSwampedNodes(actionableLabel: string) {
  const keyboardWindowIndex = 1;
  const keyboardContainerIndex = 2;
  const keys = Array.from({ length: 26 }, (_, key) => ({
    index: 3 + key,
    depth: 3,
    parentIndex: keyboardContainerIndex,
    type: 'Key',
    label: String.fromCharCode(97 + key),
    rect: { x: (key % 10) * 40, y: 600 + Math.floor(key / 10) * 54, width: 39, height: 54 },
    hittable: true,
  }));
  return [
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Example',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: true,
    },
    {
      index: keyboardWindowIndex,
      depth: 1,
      parentIndex: 0,
      type: 'Window',
      label: 'Keyboard Window',
      rect: { x: 0, y: 583, width: 402, height: 291 },
      hittable: true,
    },
    {
      index: keyboardContainerIndex,
      depth: 2,
      parentIndex: keyboardWindowIndex,
      type: 'Keyboard',
      label: 'Padding-Left',
      rect: { x: 0, y: 583, width: 402, height: 291 },
    },
    ...keys,
    {
      index: 3 + keys.length,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: actionableLabel,
      identifier: 'push-article',
      rect: { x: 20, y: 100, width: 160, height: 44 },
      hittable: true,
    },
  ];
}

test('buildReplayFailureDivergence excludes keyboard chrome from screen.refs and surfaces the actionable target within the cap', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-divergence-keyboard-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));

  mockDispatchCommand.mockResolvedValue({
    nodes: keyboardSwampedNodes('Push Article'),
    truncated: false,
    backend: 'xctest',
  });

  const action = {
    ts: 0,
    command: 'press',
    positionals: ['label="Push Article"'],
    flags: {},
    result: { selectorChain: ['label="Push Article"'] },
  };
  const divergence = await buildReplayFailureDivergence({
    error: { code: 'COMMAND_FAILED', message: 'target not found' },
    action,
    index: 0,
    sourcePath: path.join(root, 'flow.ad'),
    sourceLine: 1,
    session: sessionStore.get(sessionName),
    sessionName,
    sessionStore,
    logPath: path.join(root, 'daemon.log'),
    responseLevel: 'default',
    planActions: [action],
    planDigest: 'test-plan-digest',
  });

  expect(divergence.screen.state).toBe('available');
  const screen = divergence.screen as Extract<typeof divergence.screen, { state: 'available' }>;
  // No keyboard/IME chrome (container or individual keys) reached the ref list.
  expect(screen.refs.some((ref) => ref.role.toLowerCase() === 'key')).toBe(false);
  expect(screen.refs.some((ref) => ref.role.toLowerCase() === 'keyboard')).toBe(false);
  // The real actionable target — pushed past the cap by 28 keyboard nodes
  // before this fix — is now surfaced.
  expect(screen.refs.some((ref) => ref.label === 'Push Article')).toBe(true);
  expect(screen.truncated).toBeUndefined();
});
