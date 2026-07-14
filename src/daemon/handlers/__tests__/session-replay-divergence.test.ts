import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(async () => ({})), resolveTargetDevice: vi.fn() };
});

import { dispatchCommand } from '../../../core/dispatch.ts';
import {
  makeAndroidSession,
  makeIosSession,
} from '../../../__tests__/test-utils/session-factories.ts';
import {
  ANDROID_IME_CAPTURE_RAW_NODES,
  walkNonRawAndroidFixture,
} from '../../../__tests__/test-utils/android-ui-hierarchy-fixtures.ts';
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

// 25 unlabeled, non-interactive structural containers — the RN ViewGroup/
// FrameLayout wrappers a full (non-interactive) divergence capture pulls in.
// They carry refs but no identity and aren't tappable, and they sort ahead of
// the actionable controls in document order, so without the meaningful-target
// filter they consume the whole SCREEN_REF_CAPTURE_LIMIT and truncate the real
// controls out (the same shape as the keyboard swamp, minus the chrome).
function structuralNoiseNodes() {
  const noise = Array.from({ length: 25 }, (_, i) => ({
    index: 1 + i,
    depth: 1,
    parentIndex: 0,
    type: 'Other',
    rect: { x: 0, y: 10 * i, width: 402, height: 8 },
  }));
  const base = 1 + noise.length;
  return [
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Checkout form',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: true,
    },
    ...noise,
    {
      index: base,
      depth: 1,
      parentIndex: 0,
      type: 'StaticText',
      label: 'Full name',
      rect: { x: 20, y: 300, width: 160, height: 20 },
    },
    {
      index: base + 1,
      depth: 1,
      parentIndex: 0,
      type: 'TextField',
      value: 'ada@example.com',
      rect: { x: 20, y: 330, width: 300, height: 44 },
      hittable: true,
    },
    {
      index: base + 2,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Submit order',
      identifier: 'submit-order',
      rect: { x: 20, y: 400, width: 160, height: 44 },
      hittable: true,
    },
    // Unlabeled but interactive — a bare icon button. `hittable` alone makes it a
    // legitimate target, so it must survive even without any label/identifier.
    {
      index: base + 3,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      rect: { x: 340, y: 20, width: 44, height: 44 },
      hittable: true,
    },
  ];
}

test('buildReplayFailureDivergence drops unlabeled non-interactive structural nodes so actionable controls surface within the cap', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-divergence-structural-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));

  mockDispatchCommand.mockResolvedValue({
    nodes: structuralNoiseNodes(),
    truncated: false,
    backend: 'xctest',
  });

  const action = {
    ts: 0,
    command: 'get',
    positionals: ['text', 'label="Submit order RENAMED"'],
    flags: {},
    result: { selectorChain: ['label="Submit order RENAMED"'] },
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
  // The 25 structural wrappers no longer consume the cap, so the actionable
  // controls — which sorted after them and were truncated out before — surface.
  expect(screen.refs.some((ref) => ref.label === 'Submit order')).toBe(true);
  expect(screen.refs.some((ref) => ref.label === 'Full name')).toBe(true);
  expect(screen.refs.some((ref) => ref.label === 'ada@example.com')).toBe(true);
  // An unlabeled-but-hittable control is still a valid target.
  expect(screen.refs.some((ref) => !ref.label && ref.role.toLowerCase().includes('button'))).toBe(
    true,
  );
  // No unlabeled, non-interactive structural container leaks into the ref list.
  expect(
    screen.refs.every(
      (ref) => ref.label !== undefined || ref.role.toLowerCase().includes('button'),
    ),
  ).toBe(true);
});

// Same live-shape keyboard window, but the app hosts an inputAccessoryView
// toolbar (a "Send" button) as a bar ABOVE the keys inside the keyboard
// window. The keys are still chrome; the app-owned accessory control must NOT
// be filtered — otherwise the agent can't see/heal a control that lives there.
function keyboardWithAccessoryNodes() {
  const keyboardTop = 583;
  const keys = Array.from({ length: 26 }, (_, key) => ({
    index: 10 + key,
    depth: 3,
    parentIndex: 2,
    type: 'Key',
    label: String.fromCharCode(97 + key),
    rect: {
      x: (key % 10) * 40,
      y: keyboardTop + 10 + Math.floor(key / 10) * 54,
      width: 39,
      height: 54,
    },
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
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Window',
      label: 'Keyboard Window',
      rect: { x: 0, y: 539, width: 402, height: 335 },
      hittable: true,
    },
    // App inputAccessoryView toolbar, rendered above the keys.
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Keyboard',
      label: 'Padding-Left',
      rect: { x: 0, y: keyboardTop, width: 402, height: 291 },
    },
    ...keys,
    {
      index: 40,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Send',
      identifier: 'composer-send',
      rect: { x: 320, y: 545, width: 74, height: 40 },
      hittable: true,
    },
  ];
}

test('buildReplayFailureDivergence keeps an app inputAccessoryView control in screen.refs while filtering keyboard keys', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-divergence-accessory-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));

  mockDispatchCommand.mockResolvedValue({
    nodes: keyboardWithAccessoryNodes(),
    truncated: false,
    backend: 'xctest',
  });

  const action = {
    ts: 0,
    command: 'press',
    positionals: ['label="Send"'],
    flags: {},
    result: { selectorChain: ['label="Send"'] },
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
  // Keyboard keys are still filtered.
  expect(screen.refs.some((ref) => ref.role.toLowerCase() === 'key')).toBe(false);
  // The app's accessory "Send" button survives and is available to heal against.
  expect(screen.refs.some((ref) => ref.label === 'Send')).toBe(true);
});

// Android target-binding divergence route (#1256 test-validity fix): every
// other test in this file uses an iOS session with hand-picked mock nodes,
// which never exercises Android's status-bar/IME chrome classification. This
// test uses an ANDROID session instead, and — since `dispatchCommand` here is
// mocked (this handler's own capture step, `captureDivergenceObservation`,
// calls it downstream of the on-device Android walk, which cannot run inside
// a unit test) — feeds the mock the output of the REAL non-raw Android walk
// (`walkNonRawAndroidFixture`, `buildUiHierarchySnapshot({ raw: false })`)
// over the same real-device capture used in
// `core/__tests__/snapshot-chrome-android-statusbar.test.ts`. That means the
// walk's own inclusion/drop decisions are exercised for real; only the
// on-device transport that produces the pre-walk raw tree is stubbed.
test('buildReplayFailureDivergence excludes Android status-bar/IME chrome from screen.refs on a real (walked) non-raw capture', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-divergence-android-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(
    sessionName,
    makeAndroidSession(sessionName, { appBundleId: 'com.callstack.agentdevicelab' }),
  );

  mockDispatchCommand.mockResolvedValue({
    nodes: walkNonRawAndroidFixture(ANDROID_IME_CAPTURE_RAW_NODES),
    truncated: false,
    backend: 'android',
  });

  const action = {
    ts: 0,
    command: 'get',
    positionals: ['text', 'label="Full name RENAMED"'],
    flags: {},
    result: { selectorChain: ['label="Full name RENAMED"'] },
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

  // No status-bar/mobile/wifi systemui chrome, nor IME keys, leak into the ref
  // budget — the exact same classification as the chrome-unit test, now
  // exercised through the real divergence route.
  expect(screen.refs.some((ref) => ref.label === '7:03')).toBe(false); // clock
  expect(screen.refs.some((ref) => ref.label === 'T-Mobile, signal full.')).toBe(false); // mobile_combo
  expect(screen.refs.some((ref) => ref.label === 'Wifi signal full.')).toBe(false); // wifi_signal
  expect(screen.refs.some((ref) => ref.label === 'Shift')).toBe(false); // IME key
  expect(screen.refs.some((ref) => ref.label === 'Space')).toBe(false); // IME key
  expect(screen.refs.some((ref) => ref.label === 'Use voice typing')).toBe(false); // IME key

  // The app's own controls, real nodes from the same capture, stay visible.
  expect(screen.refs.some((ref) => ref.label === 'Checkout form')).toBe(true);
  expect(screen.refs.some((ref) => ref.label === 'review name')).toBe(true); // field-name
  expect(screen.refs.some((ref) => ref.label === 'ada@example.com')).toBe(true); // field-email
  expect(screen.refs.some((ref) => ref.label === '+48 555 010 010')).toBe(true); // field-phone
  expect(screen.truncated).toBeUndefined();
});
