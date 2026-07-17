import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(async () => ({})), resolveTargetDevice: vi.fn() };
});

// Stub the Android freshness-retry delay to a no-op so the capture-parity test
// exercises the retry BRANCH without a real wall-clock wait (repo guidance:
// no real-time sleeps in unit tests). This is the exact `sleep` the retry path
// in `snapshot-capture.ts` (`capturePostActionAwareSnapshot`) awaits; making it
// instant does not change control flow — the loop still runs, retries, and
// re-captures — so the test still proves two dispatches and use of the retried
// tree. No other test in this file triggers a sleep path.
vi.mock('../../../utils/timeouts.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/timeouts.ts')>();
  return { ...actual, sleep: vi.fn(async () => {}) };
});

import { dispatchCommand } from '../../../core/dispatch.ts';
import {
  makeAndroidSession,
  makeIosSession,
} from '../../../__tests__/test-utils/session-factories.ts';
import {
  ANDROID_IME_CAPTURE_RAW_NODES,
  ANDROID_QS_SHADE_CAPTURE_RAW_NODES,
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

// #1264 coexistence (chrome filter + overlay, real walked fixture): a
// separate-window system overlay (volume dialog) that a full `snapshot` capture
// includes survives into divergence `screen.refs` — its actionable (hittable)
// content passing the meaningful-target filter — while ordinary
// status-bar/nav-bar/IME chrome in the SAME capture is still excluded. This
// runs the real non-raw Android walk over app content + status bar + overlay
// together, proving the chrome filter and the overlay coexist. NOTE: this
// fixture is small enough that the overlay fits inside the 20-cap regardless of
// ordering, so it does NOT by itself prove cap-burial resistance — that is the
// dedicated realistic-tree test below.
test('buildReplayFailureDivergence: a system-overlay window survives into screen.refs while status/nav chrome is filtered (#1264)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-divergence-overlay-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(
    sessionName,
    makeAndroidSession(sessionName, { appBundleId: 'com.callstack.agentdevicelab' }),
  );

  const rawWithVolumeDialog = [
    ...ANDROID_IME_CAPTURE_RAW_NODES,
    {
      index: 9000,
      type: 'android.widget.FrameLayout',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/volume_dialog_container',
    },
    {
      index: 9001,
      parentIndex: 9000,
      type: 'android.widget.ImageButton',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/volume_new_ringer_active_icon_container',
      label: 'Ringer volume',
      hittable: true,
    },
  ];

  mockDispatchCommand.mockResolvedValue({
    nodes: walkNonRawAndroidFixture(rawWithVolumeDialog),
    truncated: false,
    backend: 'android',
  });

  const action = {
    ts: 0,
    command: 'press',
    positionals: ['label="Full name"'],
    flags: {},
    result: { selectorChain: ['label="Full name"'] },
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

  expect(divergence.screen.state).toBe('available');
  const screen = divergence.screen as Extract<typeof divergence.screen, { state: 'available' }>;

  // The overlay's actionable (hittable) control survives the filters, exactly
  // as a plain `snapshot` at the same moment would show it.
  expect(screen.refs.some((ref) => ref.label === 'Ringer volume')).toBe(true);

  // Ordinary status-bar/mobile/wifi systemui chrome and IME keys, present in
  // the SAME capture, are still filtered — the overlay fix does not broaden
  // the chrome filter into a no-op.
  expect(screen.refs.some((ref) => ref.label === '7:03')).toBe(false); // clock
  expect(screen.refs.some((ref) => ref.label === 'T-Mobile, signal full.')).toBe(false); // mobile_combo
  expect(screen.refs.some((ref) => ref.label === 'Wifi signal full.')).toBe(false); // wifi_signal
  expect(screen.refs.some((ref) => ref.label === 'Shift')).toBe(false); // IME key

  // App content underneath, from the same capture, is unaffected by either
  // the overlay or the chrome filter.
  expect(screen.refs.some((ref) => ref.label === 'Checkout form')).toBe(true);
  expect(screen.refs.some((ref) => ref.label === 'review name')).toBe(true); // field-name
});

// Realistic full capture: 24 app controls enumerate in document order BEFORE a
// separate-window overlay, whose lone actionable dismiss target is captured
// LAST (index 24) — exactly the shape of a live tree where the app window's
// ~77 nodes precede a volume dialog / QS shade. 24 app + 1 overlay = 25
// meaningful candidates > the 20-cap. Under the previous
// `candidates.slice(0, 20)` in document order, the overlay sits at position 24
// and is TRUNCATED away (the archived #1264 evidence: `screen.truncated: true`,
// zero volume refs). Under within-cap ranking (foreign-bundle hittable dismiss
// targets promoted ahead of app content) it survives. This test fails on
// document-order slicing and passes with the ranking.
function appSwampWithTrailingOverlay(appBundleId: string) {
  const appControls = Array.from({ length: 24 }, (_, i) => ({
    index: i,
    depth: 1,
    type: 'android.widget.Button',
    bundleId: appBundleId,
    label: `App control ${String(i + 1).padStart(2, '0')}`,
    identifier: `${appBundleId}:id/control_${i + 1}`,
    // Non-overlapping small rects down the app window: no occlusion fires.
    rect: { x: 0, y: 10 * i, width: 120, height: 8 },
    hittable: true,
  }));
  return [
    ...appControls,
    // The overlay's dismiss target, captured LAST — a foreign (systemui) window.
    {
      index: 24,
      depth: 1,
      type: 'android.widget.ImageButton',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/volume_new_ringer_active_icon_container',
      label: 'Ringer volume',
      rect: { x: 300, y: 300, width: 44, height: 44 },
      hittable: true,
    },
  ];
}

test('buildReplayFailureDivergence: a fully-captured overlay dismiss-target enumerating LAST still lands within the screen.refs cap (#1264 cap burial)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-divergence-burial-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  const appBundleId = 'com.callstack.agentdevicelab';
  sessionStore.set(sessionName, makeAndroidSession(sessionName, { appBundleId }));

  mockDispatchCommand.mockResolvedValue({
    nodes: appSwampWithTrailingOverlay(appBundleId),
    truncated: false,
    backend: 'android',
  });

  const action = {
    ts: 0,
    command: 'press',
    positionals: ['label="App control 01"'],
    flags: {},
    result: { selectorChain: ['label="App control 01"'] },
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

  expect(divergence.screen.state).toBe('available');
  const screen = divergence.screen as Extract<typeof divergence.screen, { state: 'available' }>;

  // The overlay dismiss target, captured LAST (position 24, past the 20-cap in
  // document order), survives because foreign-window hittable nodes are ranked
  // ahead of app content within the cap.
  expect(screen.refs.some((ref) => ref.label === 'Ringer volume')).toBe(true);
  // It is ranked first, not merely present.
  expect(screen.refs[0]?.label).toBe('Ringer volume');
  // Ranking is stable for equal-priority app content: the surviving app refs are
  // still the earliest ones in document order (no reshuffle).
  expect(screen.refs.some((ref) => ref.label === 'App control 01')).toBe(true);
  // The report still honestly reports it dropped candidates beyond the cap.
  expect(screen.truncated).toBe(true);
});

// Occlusion interaction (#1264): when a system overlay MASS-COVERS the app,
// every app node is annotated `interactionBlocked: 'covered'` (and
// `hittable: false`) by `annotateCoveredSnapshotNodes`. The covering overlay's
// own actionable node is NOT covered and IS the repair surface. A report whose
// capture holds these nodes but whose `refs` is empty is broken by
// construction. The overlay-like `Dialog` container (a later document node with
// a full-screen rect over the app buttons) triggers the occlusion annotation.
function overlayMassCoveringApp(appBundleId: string) {
  const appButtons = Array.from({ length: 3 }, (_, i) => ({
    index: i,
    depth: 1,
    type: 'android.widget.Button',
    bundleId: appBundleId,
    label: `Field ${String.fromCharCode(65 + i)}`,
    identifier: `${appBundleId}:id/field_${i + 1}`,
    rect: { x: 20, y: 100 + 60 * i, width: 300, height: 44 },
    hittable: true,
  }));
  const dialogIndex = appButtons.length;
  return [
    ...appButtons,
    // Overlay-like container (`Dialog` type) covering the whole app area, later
    // in document order — marks every app button `covered`. Non-hittable, so it
    // is not itself a dismiss target.
    {
      index: dialogIndex,
      depth: 0,
      type: 'android.app.Dialog',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/volume_dialog_container',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    // The overlay's actionable dismiss target, a child of the dialog.
    {
      index: dialogIndex + 1,
      parentIndex: dialogIndex,
      depth: 1,
      type: 'android.widget.ImageButton',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/volume_new_ringer_active_icon_container',
      label: 'Ringer volume',
      rect: { x: 300, y: 300, width: 44, height: 44 },
      hittable: true,
    },
  ];
}

test('buildReplayFailureDivergence: when a system overlay mass-covers the app, the overlay dismiss-target surfaces in screen.refs and refs is non-empty (#1264 occlusion)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-divergence-occlusion-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  const appBundleId = 'com.callstack.agentdevicelab';
  sessionStore.set(sessionName, makeAndroidSession(sessionName, { appBundleId }));

  mockDispatchCommand.mockResolvedValue({
    nodes: overlayMassCoveringApp(appBundleId),
    truncated: false,
    backend: 'android',
  });

  const action = {
    ts: 0,
    command: 'press',
    positionals: ['label="Field A"'],
    flags: {},
    result: { selectorChain: ['label="Field A"'] },
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

  expect(divergence.screen.state).toBe('available');
  const screen = divergence.screen as Extract<typeof divergence.screen, { state: 'available' }>;

  // A capture with meaningful nodes must never yield an empty screen.refs.
  expect(screen.refs.length).toBeGreaterThan(0);
  // The overlay's non-covered actionable node is the repair surface and surfaces.
  expect(screen.refs.some((ref) => ref.label === 'Ringer volume')).toBe(true);
  // The mass-covered app buttons are correctly excluded while a non-covered
  // dismiss target exists (they are not tappable under the overlay).
  expect(screen.refs.some((ref) => ref.label === 'Field A')).toBe(false);
});

// Occlusion fallback (#1264): the covering overlay has NO actionable node of its
// own (a bare scrim), so once the app is mass-covered there is no non-covered
// meaningful candidate at all. Rather than emit an empty `screen.refs` — a
// report broken by construction — the covered app nodes are surfaced so the
// agent at least sees what is underneath.
function bareScrimMassCoveringApp(appBundleId: string) {
  const appButtons = Array.from({ length: 3 }, (_, i) => ({
    index: i,
    depth: 1,
    type: 'android.widget.Button',
    bundleId: appBundleId,
    label: `Field ${String.fromCharCode(65 + i)}`,
    identifier: `${appBundleId}:id/field_${i + 1}`,
    rect: { x: 20, y: 100 + 60 * i, width: 300, height: 44 },
    hittable: true,
  }));
  return [
    ...appButtons,
    // Bare overlay scrim: overlay-like `Dialog` type (covers the app) but no
    // label, no identifier, non-hittable — not itself a meaningful candidate.
    {
      index: appButtons.length,
      depth: 0,
      type: 'android.app.Dialog',
      bundleId: 'com.android.systemui',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
  ];
}

test('buildReplayFailureDivergence: a mass-covered app with no actionable overlay node still returns non-empty screen.refs (#1264 occlusion fallback)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-divergence-scrim-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  const appBundleId = 'com.callstack.agentdevicelab';
  sessionStore.set(sessionName, makeAndroidSession(sessionName, { appBundleId }));

  mockDispatchCommand.mockResolvedValue({
    nodes: bareScrimMassCoveringApp(appBundleId),
    truncated: false,
    backend: 'android',
  });

  const action = {
    ts: 0,
    command: 'press',
    positionals: ['label="Field A"'],
    flags: {},
    result: { selectorChain: ['label="Field A"'] },
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

  expect(divergence.screen.state).toBe('available');
  const screen = divergence.screen as Extract<typeof divergence.screen, { state: 'available' }>;

  // No non-covered meaningful candidate exists, but the capture is not empty —
  // the covered app content is surfaced rather than returning an empty report.
  expect(screen.refs.length).toBeGreaterThan(0);
  expect(screen.refs.some((ref) => ref.label === 'Field A')).toBe(true);
});

// #1257 + #1264 reconciliation: the ADR-0014 partial ref frame the divergence
// capture activates (`markSessionPartialRefsIssued`) must authorize EXACTLY the
// refs the `screen.refs` digest renders — both now derive from the shared
// `selectDivergenceScreenRefNodes`. This is load-bearing in the mass-covered
// fallback: the screen surfaces COVERED refs, which #1257's original
// non-covered-only `digestBodies` filter would have EXCLUDED from the frame —
// leaving the agent a ref the screen advertised but the frame rejects. Assert
// the frame scope equals the emitted screen ref set (covered refs included).
test('buildReplayFailureDivergence: the partial ref frame authorizes exactly the emitted screen.refs, including mass-covered fallback refs (#1257 + #1264)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-divergence-frame-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  const appBundleId = 'com.callstack.agentdevicelab';
  sessionStore.set(sessionName, makeAndroidSession(sessionName, { appBundleId }));

  mockDispatchCommand.mockReset();
  mockDispatchCommand.mockResolvedValue({
    nodes: bareScrimMassCoveringApp(appBundleId),
    truncated: false,
    backend: 'android',
  });

  const action = {
    ts: 0,
    command: 'press',
    positionals: ['label="Field A"'],
    flags: {},
    result: { selectorChain: ['label="Field A"'] },
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

  const screen = divergence.screen as Extract<typeof divergence.screen, { state: 'available' }>;
  const screenRefBodies = new Set(screen.refs.map((ref) => ref.ref));
  expect(screenRefBodies.size).toBeGreaterThan(0);

  // The partial ref frame the capture activated authorizes exactly the emitted
  // screen refs — no more (no over-pin surface), no less (every advertised ref
  // is usable), even though every one of them is a `covered` node here.
  const stored = sessionStore.get(sessionName);
  expect(stored?.refFrameState).toBe('active');
  expect(stored?.refFrameScope).toEqual(screenRefBodies);
});

// #1264 (capture parity, point 1): the divergence capture must go through the
// SAME `captureSnapshot` wrapper as a plain `snapshot`, so it inherits Android
// freshness + post-action retry. Otherwise a divergence could consume the first
// stale / app-scoped dump while a plain `snapshot` retries to the fresh
// full-window tree — a divergence STALER than `snapshot`. Here the session
// carries an active Android freshness marker (baselineCount 20); the first
// on-device dump is a stale, near-empty tree (sharp node-count drop, no
// meaningful content → the `sharp-drop` retry trigger), and only the RETRIED
// second dump contains the system overlay. The divergence must reflect the
// retried tree. The retry delay (`sleep`) is stubbed to a no-op at the top of
// this file, so the retry BRANCH runs without a real wall-clock wait.
test('buildReplayFailureDivergence: routes through the freshness-retry wrapper and uses the retried fresh tree, not the first stale dump (#1264 capture parity)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-divergence-fresh-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  const appBundleId = 'com.callstack.agentdevicelab';
  const session = makeAndroidSession(sessionName, { appBundleId });
  // Active freshness marker: a navigation-sensitive action just ran, and the
  // pre-action baseline had 20 nodes, so a near-empty next dump is suspicious.
  session.androidSnapshotFreshness = {
    action: 'press',
    markedAt: Date.now(),
    baselineCount: 20,
    routeComparable: false,
  };
  sessionStore.set(sessionName, session);

  // Capture 1: stale, near-empty dump (a single bare view — no hittable/label/
  // id) → `sharp-drop` vs the 20-node baseline → triggers a retry.
  const staleDump = {
    nodes: [
      {
        index: 0,
        type: 'android.view.View',
        bundleId: appBundleId,
        rect: { x: 0, y: 0, width: 10, height: 10 },
      },
    ],
    truncated: false,
    backend: 'android',
  };
  // Capture 2: the fresh full-window tree, holding the app control AND the
  // separate-window system overlay's dismiss target.
  const freshDump = {
    nodes: [
      {
        index: 0,
        type: 'android.widget.Button',
        bundleId: appBundleId,
        label: 'App control',
        identifier: `${appBundleId}:id/control`,
        rect: { x: 20, y: 100, width: 200, height: 44 },
        hittable: true,
      },
      {
        index: 1,
        type: 'android.widget.ImageButton',
        bundleId: 'com.android.systemui',
        identifier: 'com.android.systemui:id/volume_new_ringer_active_icon_container',
        label: 'Ringer volume',
        rect: { x: 300, y: 300, width: 44, height: 44 },
        hittable: true,
      },
    ],
    truncated: false,
    backend: 'android',
  };
  mockDispatchCommand.mockReset();
  mockDispatchCommand.mockResolvedValueOnce(staleDump).mockResolvedValueOnce(freshDump);

  const action = {
    ts: 0,
    command: 'press',
    positionals: ['label="App control"'],
    flags: {},
    result: { selectorChain: ['label="App control"'] },
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

  // The freshness wrapper retried past the stale dump (2 on-device captures).
  expect(mockDispatchCommand).toHaveBeenCalledTimes(2);

  expect(divergence.screen.state).toBe('available');
  const screen = divergence.screen as Extract<typeof divergence.screen, { state: 'available' }>;
  // The overlay only exists in the RETRIED capture, so its presence proves the
  // divergence used the fresh tree — parity with what a plain `snapshot` sees.
  expect(screen.refs.some((ref) => ref.label === 'Ringer volume')).toBe(true);
  expect(screen.refs.some((ref) => ref.label === 'App control')).toBe(true);
});

// #1264 (clean flags policy, point 2): a failed `snapshot --raw`/scoped/`-d`
// action must never narrow the DIAGNOSTIC divergence tree. The divergence
// capture builds its flags from a fixed policy (full-window, non-raw, default
// depth), NOT from the failed action's flags — so `snapshotRaw`/`snapshotScope`/
// `snapshotDepth` on the action do not reach the capture. This inspects the
// context handed to the snapshot dispatch and asserts those narrowing flags are
// dropped while the interactive-only policy is still applied.
test('buildReplayFailureDivergence: divergence capture drops the action snapshotRaw/scope/depth flags (#1264 clean flags policy)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-divergence-flags-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  const appBundleId = 'com.callstack.agentdevicelab';
  sessionStore.set(sessionName, makeAndroidSession(sessionName, { appBundleId }));

  mockDispatchCommand.mockReset();
  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        type: 'android.widget.Button',
        bundleId: appBundleId,
        label: 'Submit',
        identifier: `${appBundleId}:id/submit`,
        rect: { x: 20, y: 100, width: 200, height: 44 },
        hittable: true,
      },
    ],
    truncated: false,
    backend: 'android',
  });

  // A failed action that itself requested a raw, ref-scoped, depth-limited
  // snapshot — none of which may reshape the divergence diagnostic tree.
  const action = {
    ts: 0,
    command: 'press',
    positionals: ['label="Submit"'],
    flags: { snapshotRaw: true, snapshotScope: '@e5', snapshotDepth: 2 },
    result: { selectorChain: ['label="Submit"'] },
  };
  await buildReplayFailureDivergence({
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

  expect(mockDispatchCommand).toHaveBeenCalled();
  const context = mockDispatchCommand.mock.calls[0]?.[4] as
    | {
        snapshotRaw?: boolean;
        snapshotScope?: string;
        snapshotDepth?: number;
        snapshotInteractiveOnly?: boolean;
      }
    | undefined;
  // The action's narrowing flags are stripped by the fixed divergence policy.
  expect(context?.snapshotRaw).not.toBe(true);
  expect(context?.snapshotScope).toBeUndefined();
  expect(context?.snapshotDepth).toBeUndefined();
  // The interactive-only policy (press → interactive) is still applied.
  expect(context?.snapshotInteractiveOnly).toBe(true);
});

// Wave-3 leg E (real walked fixture): a FULL-COVER quick-settings shade. Unlike
// the partial-cover overlay above, the shade owns the whole screen — every node
// is systemui and the status-bar icons share the shade's own window, so the
// run-level chrome rule (`collectAndroidSystemChromeRunIndexes`) condemns the
// ENTIRE capture, tiles included. The chrome filter must stay a FILTER and never
// become a narrower scoping (`captureDivergenceObservation`): a plain `snapshot`
// of this exact surface shows the tiles (#1301 `systemSurfaceOnly` carve-out), so
// a divergence publishing zero refs would be strictly NARROWER than `snapshot` —
// the invariant that amendment forbids. Live-verified 2026-07-17 on emulator-5556:
// pre-fix this screen came back with 0 refs.
test('buildReplayFailureDivergence: a full-cover quick-settings shade still publishes its hittable tiles (wave-3 leg E)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-divergence-qsshade-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(
    sessionName,
    makeAndroidSession(sessionName, { appBundleId: 'com.google.android.deskclock' }),
  );

  const walked = walkNonRawAndroidFixture(ANDROID_QS_SHADE_CAPTURE_RAW_NODES);
  mockDispatchCommand.mockResolvedValue({ nodes: walked, truncated: false, backend: 'android' });

  const action = {
    ts: 0,
    command: 'get',
    positionals: ['text', 'label="World Clock"'],
    flags: {},
    result: { selectorChain: ['label="World Clock"'] },
  };
  const divergence = await buildReplayFailureDivergence({
    error: { code: 'COMMAND_FAILED', message: 'Selector did not match: label="World Clock"' },
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

  // The capture plainly holds actionable nodes, so the screen must not be empty:
  // never NARROWER than the `snapshot` of the same surface.
  expect(walked.some((node) => node.hittable === true)).toBe(true);
  expect(screen.refs.length).toBeGreaterThan(0);

  // The shade's own interaction targets — the reason an agent is shown this
  // screen at all — are what it publishes. Compose quick-settings tiles expose
  // no per-tile label (they rank in as unlabeled hittable `group`s); the
  // brightness slider is the one carrying real text.
  expect(screen.refs.some((ref) => ref.label === 'Display brightness')).toBe(true);
  expect(screen.refs.length).toBe(20); // SCREEN_REF_CAPTURE_LIMIT, from 23 hittable tiles
  expect(screen.truncated).toBe(true);

  // Still a filter, not a blanket chrome dump: EVERY published ref is a node an
  // agent can actually act on, so the non-hittable status residue in the SAME
  // condemned run (battery/wifi/mobile icons) never rides along.
  const published = new Map(
    (sessionStore.get(sessionName)?.snapshot?.nodes ?? []).map((node) => [node.ref, node]),
  );
  expect(screen.refs.every((ref) => published.get(ref.ref)?.hittable === true)).toBe(true);
  expect(screen.refs.some((ref) => ref.label === 'Battery charging, 100 percent.')).toBe(false);
  expect(screen.refs.some((ref) => ref.label === 'Wifi signal full.')).toBe(false);
});

// The hittable gate on the chrome fallback, pinned against the OTHER real
// capture: an ordinary COLLAPSED status bar (with app content present) must not
// be promoted. Its clock is labeled but NOT hittable in the real capture, while
// the expanded shade's big clock IS — which is exactly why hittability, not
// label presence, is the gate. Without this the fallback would publish a bare
// "7:03" as the screen whenever an app tree yielded no meaningful targets.
test('buildReplayFailureDivergence: the chrome fallback never promotes a non-hittable collapsed status bar', async () => {
  const collapsedClock = ANDROID_IME_CAPTURE_RAW_NODES.find(
    (node) => node.identifier === 'com.android.systemui:id/clock',
  );
  expect(collapsedClock?.label).toBe('7:03');
  expect(collapsedClock?.hittable).not.toBe(true);

  const shadeClock = ANDROID_QS_SHADE_CAPTURE_RAW_NODES.find(
    (node) => node.identifier === 'com.android.systemui:id/clock',
  );
  expect(shadeClock?.hittable).toBe(true);
});
