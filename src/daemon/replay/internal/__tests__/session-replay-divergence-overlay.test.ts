import { divergenceFixture } from './session-replay-divergence.fixtures.ts';
import path from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';
import { makeAndroidSession } from '../../../../__tests__/test-utils/session-factories.ts';
import {
  ANDROID_IME_CAPTURE_RAW_NODES,
  walkNonRawAndroidFixture,
} from '../../../../__tests__/test-utils/android-ui-hierarchy-fixtures.ts';
import { SessionStore } from '../../../session-store.ts';
import { replayDivergenceForTest } from './replay-session-fixture.ts';
import { refFrameScope, refFrameState } from '../../../ref-frame.ts';

const { buildReplayFailureDivergence, mockDispatchCommand, resetDivergenceCapture } =
  divergenceFixture;

// #1264: a separate-window system overlay (a volume dialog / QS shade) must coexist
// with the chrome filter and survive into `screen.refs` — even when its lone
// actionable dismiss target enumerates LAST, past the 20-cap in document order, or
// when the overlay mass-covers the app. The partial ref frame the capture activates
// must then authorize exactly the emitted screen refs, covered fallback refs included.

beforeEach(resetDivergenceCapture);

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
  const root = mkdtempForTestSync('agent-device-replay-divergence-overlay-');
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
    ...replayDivergenceForTest(sessionStore, sessionName),
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
  const root = mkdtempForTestSync('agent-device-replay-divergence-burial-');
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
    ...replayDivergenceForTest(sessionStore, sessionName),
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
  const root = mkdtempForTestSync('agent-device-replay-divergence-occlusion-');
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
    ...replayDivergenceForTest(sessionStore, sessionName),
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
  const root = mkdtempForTestSync('agent-device-replay-divergence-scrim-');
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
    ...replayDivergenceForTest(sessionStore, sessionName),
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
  const root = mkdtempForTestSync('agent-device-replay-divergence-frame-');
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
    ...replayDivergenceForTest(sessionStore, sessionName),
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
  expect(refFrameState(stored!)).toBe('active');
  expect(refFrameScope(stored!)).toEqual(screenRefBodies);
});
