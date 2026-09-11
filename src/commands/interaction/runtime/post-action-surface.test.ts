import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { summarizeAxEvidence } from '@agent-device/capture-kit/snapshot-evidence';
import { IOS_SYSTEM_SURFACE_DISCLOSURE } from '@agent-device/contracts/ios-system-surface';
import { selector } from './selector-read-utils.ts';
import {
  buttonSnapshot,
  createSettleDevice,
  welcomeSnapshot,
} from './__tests__/settle-device-fixtures.ts';

// #2438 cross-surface settle: iOS serves a web sign-in sheet
// (com.apple.SafariViewService) IN PLACE over a still-foreground app, so a settled
// capture of the sheet and a pre-action capture of the app describe DIFFERENT
// surfaces. A diff between them is a whole-surface replacement dressed as change
// within one surface — and, since diff presence is what issues refs, it would hand
// the caller refs for that claim.
const WEB_SIGN_IN_SHEET_BUNDLE_ID = 'com.apple.SafariViewService';

function webSignInSheetSnapshot(labels: string[]): SnapshotState {
  return {
    ...makeSnapshotState(
      labels.map((label, index) => ({
        index,
        depth: 0,
        type: 'Button',
        label,
        rect: { x: 10, y: 20 + index * 50, width: 200, height: 40 },
        hittable: true,
      })),
    ),
    iosSystemSurfaceBundleId: WEB_SIGN_IN_SHEET_BUNDLE_ID,
  };
}

// Five labels so a settled sheet clears the tiny-tree readiness heuristic, and a
// `Continue` control so the same selector also resolves on the sheet.
const WEB_SIGN_IN_SHEET_LABELS = [
  'Continue',
  'Sign in with Example',
  'Email',
  'Password',
  'Cancel',
];

test('press --settle attaches no diff across an app-to-sheet surface change and discloses it', async () => {
  const before = buttonSnapshot();
  const sheet = webSignInSheetSnapshot(WEB_SIGN_IN_SHEET_LABELS);
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    captureSnapshot: () => {
      captures += 1;
      // Capture 1 = selector resolution (app baseline). Captures 2+ = the settle
      // loop, reading the sheet now presented over that app.
      return { snapshot: captures === 1 ? before : sheet };
    },
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
    settle: {},
  });

  const settle = result.settle;
  assert.ok(settle);
  assert.equal(settle.settled, true);
  assert.deepEqual(settle.surfaceChange, {
    from: 'app',
    to: WEB_SIGN_IN_SHEET_BUNDLE_ID,
    disclosure: IOS_SYSTEM_SURFACE_DISCLOSURE,
  });
  // No same-surface claim: no diff, so no issued refs, and no tail either.
  assert.equal(settle.diff, undefined);
  assert.equal(settle.tail, undefined);
  assert.match(settle.hint ?? '', /different surfaces/);
  assert.match(settle.hint ?? '', /take a snapshot/i);
  // Disclosed, not hidden: the settled sheet still becomes the stored observation
  // a follow-up snapshot reads.
  const stored = (await device.sessions.get('default')) as { snapshot?: SnapshotState };
  assert.equal(stored.snapshot?.iosSystemSurfaceBundleId, WEB_SIGN_IN_SHEET_BUNDLE_ID);
});

test('press --settle attaches no diff across a sheet-to-app surface change and discloses it', async () => {
  const sheet = webSignInSheetSnapshot(WEB_SIGN_IN_SHEET_LABELS);
  const app = welcomeSnapshot();
  let captures = 0;
  const device = createSettleDevice({
    stored: sheet,
    captureSnapshot: () => {
      captures += 1;
      // The baseline is the sheet this press acts on; the settled tree is the app
      // content that returns once the sheet completes and dismisses itself.
      return { snapshot: captures === 1 ? sheet : app };
    },
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
    settle: {},
  });

  const settle = result.settle;
  assert.ok(settle);
  assert.equal(settle.settled, true);
  assert.equal(settle.surfaceChange?.from, WEB_SIGN_IN_SHEET_BUNDLE_ID);
  assert.equal(settle.surfaceChange?.to, 'app');
  assert.match(settle.surfaceChange?.disclosure ?? '', /sign-in sheet/);
  // The sheet is gone, so the standing "is presented over the app" sentence cannot
  // be the one used.
  assert.notEqual(settle.surfaceChange?.disclosure, IOS_SYSTEM_SURFACE_DISCLOSURE);
  assert.equal(settle.diff, undefined);
  assert.equal(settle.tail, undefined);
  assert.match(settle.hint ?? '', /different surfaces/);
});

test('press --settle --verify reports one app-to-sheet surface change on both payloads', async () => {
  const before = buttonSnapshot();
  const sheet = webSignInSheetSnapshot(WEB_SIGN_IN_SHEET_LABELS);
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    captureSnapshot: () => {
      captures += 1;
      return { snapshot: captures === 1 ? before : sheet };
    },
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
    settle: {},
    verify: true,
  });

  // The settle loop's final capture doubles as the verify evidence source, so the
  // shared evidence path must refuse the cross-surface digest comparison too.
  assert.deepEqual(result.evidence?.surfaceChange, {
    from: 'app',
    to: WEB_SIGN_IN_SHEET_BUNDLE_ID,
    disclosure: IOS_SYSTEM_SURFACE_DISCLOSURE,
  });
  assert.equal(result.evidence?.changedFromBefore, true);
  assert.equal(result.settle?.surfaceChange?.to, WEB_SIGN_IN_SHEET_BUNDLE_ID);
  assert.equal(result.settle?.diff, undefined);
});

test('press --settle --verify reports a sheet-to-app surface change when the digests coincide', async () => {
  const sheet: SnapshotState = {
    ...welcomeSnapshot(),
    iosSystemSurfaceBundleId: WEB_SIGN_IN_SHEET_BUNDLE_ID,
  };
  const app = welcomeSnapshot();
  // The premise this test exists for: the sheet tree and the app tree that replaces
  // it digest identically, so a digest comparison would report "nothing changed"
  // across a whole-surface replacement.
  assert.equal(summarizeAxEvidence(sheet.nodes).digest, summarizeAxEvidence(app.nodes).digest);
  let captures = 0;
  const device = createSettleDevice({
    stored: sheet,
    captureSnapshot: () => {
      captures += 1;
      return { snapshot: captures === 1 ? sheet : app };
    },
  });

  const result = await device.interactions.press(selector('label=Next'), {
    session: 'default',
    settle: {},
    verify: true,
  });

  assert.equal(result.evidence?.surfaceChange?.from, WEB_SIGN_IN_SHEET_BUNDLE_ID);
  assert.equal(result.evidence?.surfaceChange?.to, 'app');
  assert.equal(result.evidence?.changedFromBefore, true);
  assert.equal(result.settle?.surfaceChange?.from, WEB_SIGN_IN_SHEET_BUNDLE_ID);
  assert.equal(result.settle?.diff, undefined);
});
