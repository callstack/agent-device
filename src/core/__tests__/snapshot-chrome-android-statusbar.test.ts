import { test } from 'vitest';
import assert from 'node:assert/strict';
import { attachRefs, type RawSnapshotNode, type SnapshotNode } from '../../kernel/snapshot.ts';
import { collectSettleChromeRefs, withoutSettleChrome } from '../snapshot-chrome.ts';
import {
  ANDROID_IME_CAPTURE_RAW_NODES,
  ANDROID_QS_SHADE_CAPTURE_RAW_NODES,
  walkInteractiveOnlyAndroidFixture,
  walkNonRawAndroidFixture,
} from '../../__tests__/test-utils/android-ui-hierarchy-fixtures.ts';

/**
 * `ANDROID_IME_CAPTURE_RAW_NODES` (shared test util, see its own doc comment)
 * is a real device `--raw` capture: `--raw` keeps every structural wrapper
 * node (`status_bar_container`, `status_bar_contents`, ...) so the OLD
 * prefix-only marker check finds them and drops the whole run.
 *
 * The default (non-raw) walk drops unlabeled/unidentified structural nodes
 * (`shouldIncludeStructuralAndroidNode` in `platforms/android/ui-hierarchy.ts`),
 * re-parenting their children upward — which silently removes every one of
 * those marker-bearing wrappers AND several other anonymous structural nodes
 * that have neither a hittable descendant nor meaningful text/id (a real
 * `android.view.View` example is `com.android.systemui:id/home_handle`, see
 * the nav-bar test below). `walkNonRawAndroidFixture` (shared test util) runs
 * the fixture through the REAL `buildUiHierarchySnapshot({ raw: false })`
 * walk instead of hand-simulating a subset of its drops, so every inclusion
 * decision below is production's, not a guess at which nodes matter.
 */

function refForIdentifier(nodes: SnapshotNode[], identifier: string): string {
  const node = nodes.find((candidate) => candidate.identifier === identifier);
  assert.ok(node?.ref, `expected a node identified "${identifier}" with a ref`);
  return node.ref;
}

/**
 * Status-bar leaf identifiers that SURVIVE the real non-raw walk for this
 * fixture (verified against `buildUiHierarchySnapshot({ raw: false })`
 * directly). Several ids the naive prefix-only simulation used to assert
 * (`notification_icon_area`, `notificationIcons`, `cutout_space_view`,
 * `system_icons`, `statusIcons`, `mobile_group`, `wifi_combo`, `wifi_group`,
 * `start_side_notif_and_chip_container`, `battery`) are unlabeled structural
 * wrappers with a generic resource id and no hittable descendant: production
 * `shouldIncludeStructuralAndroidNode` drops every one of them too, same as
 * the `status_bar*`/`navigation_bar*` wrappers. Their content isn't lost —
 * `battery`'s labeled child ("Battery 100 percent.") re-parents upward and is
 * covered by the "every systemui-owned node is chrome" assertion below — but
 * the WRAPPER identifier itself is gone from the walked tree, so it can't be
 * looked up by id.
 */
const STATUS_BAR_LEAF_IDENTIFIERS = [
  'com.android.systemui:id/clock',
  'com.android.systemui:id/mobile_combo',
  'com.android.systemui:id/mobile_signal',
  'com.android.systemui:id/wifi_signal',
];

test('Android non-raw capture: status-bar leaves are recognized as chrome once their status_bar*/navigation_bar* marker wrapper is dropped by the walk (#1251)', () => {
  const walkedNodes = walkNonRawAndroidFixture(ANDROID_IME_CAPTURE_RAW_NODES);
  const nodes = attachRefs(walkedNodes);
  const chromeRefs = collectSettleChromeRefs(nodes, 'com.callstack.agentdevicelab');

  // None of the status_bar*/navigation_bar* WRAPPER identifiers survive the
  // real walk at all — confirms the walk, not this test, is doing the drop.
  for (const node of nodes) {
    const identifier = node.identifier ?? '';
    assert.equal(
      identifier.startsWith('com.android.systemui:id/status_bar') ||
        identifier.startsWith('com.android.systemui:id/navigation_bar'),
      false,
      `expected the walk to have dropped wrapper "${identifier}"`,
    );
  }

  for (const identifier of STATUS_BAR_LEAF_IDENTIFIERS) {
    assert.equal(
      chromeRefs.has(refForIdentifier(nodes, identifier)),
      true,
      `expected ${identifier} to be classified as systemui chrome`,
    );
  }

  // The whole systemui run drops together, including the anonymous Compose
  // plumbing nodes above/around the leaves that carry no identifier at all
  // (and the re-parented, now-anonymous battery leaf).
  const systemUiRefs = nodes
    .filter((node) => node.bundleId === 'com.android.systemui')
    .map((node) => node.ref);
  assert.equal(systemUiRefs.length > 0, true);
  for (const ref of systemUiRefs) {
    assert.equal(chromeRefs.has(ref), true, 'expected every systemui-owned node to be chrome');
  }

  // App fields and the IME keyboard, both real nodes from the same capture,
  // are handled exactly as before: the checkout form stays fully visible and
  // the IME keyboard is still classified as chrome in full.
  assert.equal(chromeRefs.has(refForIdentifier(nodes, 'field-name')), false);
  assert.equal(chromeRefs.has(refForIdentifier(nodes, 'field-email')), false);
  assert.equal(chromeRefs.has(refForIdentifier(nodes, 'field-phone')), false);
  const imeRefs = nodes
    .filter((node) => node.bundleId === 'com.google.android.inputmethod.latin')
    .map((node) => node.ref);
  assert.equal(imeRefs.length > 0, true);
  for (const ref of imeRefs) {
    assert.equal(chromeRefs.has(ref), true, 'expected every IME-owned node to be chrome');
  }
});

test('Android actionable systemui overlay (volume dialog) still survives the chrome filter (#1251)', () => {
  // Filter-logic unit test, NOT a live-capture-path claim (#1264 finding 2): this
  // exercises `collectSettleChromeRefs` in isolation over a synthetic systemui
  // run appended to an unrelated capture fixture. The leaf ids ARE real,
  // live-verified volume-dialog ids (`volume_dialog_container`,
  // `volume_new_ringer_active_icon_container`), but appending them to this
  // fixture does not reproduce how a live capture reaches the filter — that is
  // covered separately by the full-capture invariant test below. The point
  // here is narrower: the status-bar/nav-bar leaf-id set (#1251) must NOT
  // broaden to "any systemui id" and drop an actionable overlay it is handed.
  const rawWithVolumeDialog: RawSnapshotNode[] = [
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
  const nodes = attachRefs(walkNonRawAndroidFixture(rawWithVolumeDialog));
  const chromeRefs = collectSettleChromeRefs(nodes, 'com.callstack.agentdevicelab');

  // The container is non-hittable with a generic id, but its hittable
  // `volume_new_ringer_active_icon_container` child keeps it in the walked
  // tree (descendantHittable).
  assert.equal(
    chromeRefs.has(refForIdentifier(nodes, 'com.android.systemui:id/volume_dialog_container')),
    false,
  );
  assert.equal(
    chromeRefs.has(
      refForIdentifier(nodes, 'com.android.systemui:id/volume_new_ringer_active_icon_container'),
    ),
    false,
  );
  // The status-bar leak fix stays active in the very same tree.
  assert.equal(chromeRefs.has(refForIdentifier(nodes, 'com.android.systemui:id/clock')), true);
});

/**
 * Synthetic: the real capture (#1251) has no nav bar (gesture-nav device).
 * `home_handle` is an `android.view.View` with a generic resource id, no
 * label, and (unlike `volume_dialog_slider` above) is neither hittable nor
 * home to a hittable descendant — production's `shouldIncludeStructuralAndroidNode`
 * drops it before `collectSettleChromeRefs` ever runs, so it is simply ABSENT
 * from the walked tree, not present-and-classified-as-chrome (the reviewer's
 * exact test-validity finding on #1256: the old hand-simulation only stripped
 * `status_bar*`/`navigation_bar*` wrappers and kept `home_handle` around to
 * assert it as chrome, which the real walk never does).
 */
test('Android nav-bar leaves are recognized as chrome once their navigation_bar* marker wrapper is dropped (synthetic: the real capture has no nav bar, gesture-nav device) (#1251)', () => {
  const rawNavBarNodes: RawSnapshotNode[] = [
    { index: 0, type: 'android.widget.FrameLayout', bundleId: 'com.android.systemui' },
    {
      index: 1,
      parentIndex: 0,
      type: 'android.widget.FrameLayout',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/navigation_bar_frame',
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'android.widget.LinearLayout',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/nav_buttons',
    },
    {
      index: 3,
      parentIndex: 2,
      type: 'android.widget.ImageView',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/back',
      label: 'Back',
    },
    {
      index: 4,
      parentIndex: 2,
      type: 'android.widget.ImageView',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/home',
      label: 'Home',
    },
    {
      index: 5,
      parentIndex: 2,
      type: 'android.widget.ImageView',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/recent_apps',
      label: 'Overview',
    },
    {
      // Unlabeled, non-hittable, generic-id `android.view.View`: the real
      // walk drops this (no meaningful text/id, no hittable descendant),
      // unlike `back`/`home`/`recent_apps` which carry a label.
      index: 6,
      parentIndex: 1,
      type: 'android.view.View',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/home_handle',
    },
  ];
  const walkedNodes = walkNonRawAndroidFixture(rawNavBarNodes);
  const nodes = attachRefs(walkedNodes);
  const chromeRefs = collectSettleChromeRefs(nodes, 'com.example.app');

  for (const identifier of [
    'com.android.systemui:id/back',
    'com.android.systemui:id/home',
    'com.android.systemui:id/recent_apps',
  ]) {
    assert.equal(chromeRefs.has(refForIdentifier(nodes, identifier)), true, identifier);
  }

  // home_handle is DROPPED by the real walk (unlabeled, non-hittable, no
  // hittable descendant, generic id) — it must be absent, not chrome-classified.
  assert.equal(
    walkedNodes.some((node) => node.identifier === 'com.android.systemui:id/home_handle'),
    false,
    'expected home_handle to be dropped by the real non-raw walk, not retained',
  );
});

/**
 * #1319: `--settle` is NOT blind to a fully expanded quick-settings shade.
 * Live-verified on emulator-5554 (Pixel 9 Pro XL API 37, deskclock) in both
 * directions — opening mid-settle diffs `+28 -25`, closing diffs `+25 -28` —
 * while the shade's own status bar stays stripped from both.
 *
 * The classification is capture-shape-dependent, which is the real defect
 * (#1319 has the measurements): the same shade is ONE condemned run under the
 * `--raw`/non-raw walk #1318 measured, and separate runs under the
 * `interactiveOnly: true` walk settle captures with, because that walk also
 * drops the systemui spine holding the run together. Settle lands on the right
 * side of that; the divergence layer needed its own fallback to.
 *
 * Until the shape-dependence is fixed upstream, this is what holds the settle
 * side in place: retaining the spine in the interactive walk re-merges the
 * runs and makes `--settle` report a full-cover shade as bare removals with no
 * added content.
 */
test('Android expanded quick-settings shade stays visible to --settle while its status bar is still stripped (#1319)', () => {
  const appBundleId = 'com.google.android.deskclock';
  const nodes = attachRefs(walkInteractiveOnlyAndroidFixture(ANDROID_QS_SHADE_CAPTURE_RAW_NODES));
  const kept = withoutSettleChrome(nodes, appBundleId);
  const keptIdentifiers = new Set(kept.map((node) => node.identifier));

  // The shade's actionable content reaches both diff sides, so opening or
  // closing it can never read as "nothing changed".
  assert.equal(keptIdentifiers.has('com.android.systemui:id/expanded_qs_scroll_view'), true);
  assert.equal(keptIdentifiers.has('com.android.systemui:id/slider'), true);
  assert.equal(
    kept.filter((node) => node.identifier?.startsWith('com.android.systemui:id/qs_tile_')).length >
      0,
    true,
    'expected the quick-settings tiles to survive settle chrome stripping',
  );

  // ...and the run rule still does the job it was written for: the status-bar
  // run (clock/date/carrier/wifi ticking every second) is the canonical churn
  // settle exists to ignore, so sparing the shade must not spare that too.
  const chromeRefs = collectSettleChromeRefs(nodes, appBundleId);
  for (const identifier of [
    'com.android.systemui:id/split_shade_status_bar',
    'com.android.systemui:id/clock',
    'com.android.systemui:id/wifi_signal',
  ]) {
    assert.equal(chromeRefs.has(refForIdentifier(nodes, identifier)), true, identifier);
    assert.equal(keptIdentifiers.has(identifier), false, identifier);
  }

  // The contrast that explains the whole finding: the SAME capture, walked the
  // way the divergence layer receives it, is one run and loses everything.
  // This is what #1318 measured; settle escapes it only via the extra drops.
  const nonRawNodes = attachRefs(walkNonRawAndroidFixture(ANDROID_QS_SHADE_CAPTURE_RAW_NODES));
  assert.equal(withoutSettleChrome(nonRawNodes, appBundleId).length, 0);
});
