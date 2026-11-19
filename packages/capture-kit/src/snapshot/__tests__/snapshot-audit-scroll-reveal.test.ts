import { expect, test } from 'vitest';
import type { AuditContext, AuditFinding } from '@agent-device/contracts/capture';
import type { RawSnapshotNode, SnapshotNode } from '@agent-device/kernel/snapshot';
import { annotateCoveredSnapshotNodes } from '../../snapshot-occlusion.ts';
import { auditSnapshot } from '../snapshot-audit.ts';

// Covered controls under persistent bars: which ones a scroll can reveal (scrollCanReveal), and
// which ones the audit therefore keeps or drops. Each coveredBy comes from the real occlusion scan.

const IOS: AuditContext = { platform: 'ios', producer: 'apple-runner', truncated: false };
const ANDROID: AuditContext = { platform: 'android', pixelDensity: 2, truncated: false };

function audit(nodes: SnapshotNode[], context: AuditContext = IOS) {
  return auditSnapshot(nodes, context);
}

function summarize(findings: AuditFinding[]): string[] {
  return findings.map((finding) => `${finding.kind} ${finding.ref}`);
}

test('keeps the covered-control finding for a button in a horizontal scroller wholly behind a bottom bar', () => {
  // The bar contains the scroller's whole usable viewport (400x65 inside the 400x75 bar), so no
  // scroll can reveal the button: the audit keeps the finding instead of excluding it as scroll
  // chrome. The occlusion scan produces the `coveredBy`, as in a real capture.
  const raw: RawSnapshotNode[] = [
    { index: 0, depth: 0, type: 'Window', rect: { x: 0, y: 0, width: 400, height: 800 } },
    {
      index: 1,
      parentIndex: 0,
      depth: 1,
      type: 'android.widget.HorizontalScrollView',
      rect: { x: 0, y: 725, width: 400, height: 65 },
    },
    {
      index: 2,
      parentIndex: 1,
      depth: 2,
      type: 'Button',
      label: 'Buy now',
      hittable: true,
      rect: { x: 20, y: 735, width: 120, height: 50 },
    },
    {
      index: 3,
      parentIndex: 0,
      depth: 1,
      type: 'com.google.android.material.bottomnavigation.BottomNavigationView',
      hittable: true,
      rect: { x: 0, y: 725, width: 400, height: 75 },
    },
  ];
  const nodes = annotateCoveredSnapshotNodes(raw, { producer: 'android-uiautomator' }).map(
    (scanned) => ({
      ...scanned,
      ref: `e${scanned.index}`,
    }),
  );
  expect(nodes[2]).toMatchObject({
    interactionBlocked: 'covered',
    coveredBy: { persistentBar: true },
  });
  // The bar contains the scroller's whole frame, so no scroll can reveal the button.
  expect(nodes[2]?.coveredBy?.scrollCanReveal).toBeUndefined();
  expect(summarize(audit(nodes, ANDROID).findings)).toEqual(['covered-control @e2']);
});

test('drops the covered-control finding for a row under the floating tab bar that scrolling reveals (#4763)', () => {
  // The captured Pantry Recipes shape (iOS 26.2, dev.uisdk.nativeproto, initial scroll position):
  // a full-viewport ScrollView holds the recipe rows and the UITabBar at (0,791 402x83) covers the
  // Berry Overnight Oats row. Scrolling down reveals the row, so the occlusion scan publishes
  // `scrollCanReveal` on the bar cover and the audit reports nothing for the row. The occlusion
  // scan produces the `coveredBy`, as in a real capture.
  const raw: RawSnapshotNode[] = [
    {
      index: 0,
      depth: 0,
      type: 'Application',
      role: 'UIApplication',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      parentIndex: 0,
      depth: 1,
      type: 'ScrollView',
      role: 'RCTEnhancedScrollView',
      subrole: 'UIScrollView',
      hiddenContentBelow: true,
      hittable: true,
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 2,
      parentIndex: 1,
      depth: 2,
      type: 'Button',
      role: 'RCTViewComponentView',
      label: 'Chicken Harvest Bowl, 35 minutes',
      hittable: true,
      rect: { x: 32, y: 679, width: 308, height: 90 },
    },
    {
      index: 3,
      parentIndex: 1,
      depth: 2,
      type: 'Button',
      role: 'RCTViewComponentView',
      label: 'Berry Overnight Oats, 5 minutes',
      hittable: true,
      rect: { x: 32, y: 805, width: 308, height: 69 },
    },
    {
      index: 4,
      parentIndex: 1,
      depth: 2,
      type: 'Button',
      role: 'RCTViewComponentView',
      label: 'Unsave Berry Overnight Oats',
      hittable: true,
      rect: { x: 348, y: 807, width: 22, height: 22 },
    },
    {
      index: 5,
      parentIndex: 0,
      depth: 1,
      type: 'TabBar',
      role: 'UITabBar',
      label: 'Tab Bar',
      hittable: true,
      rect: { x: 0, y: 791, width: 402, height: 83 },
    },
  ];
  const nodes = annotateCoveredSnapshotNodes(raw, { producer: 'apple-runner' }).map((scanned) => ({
    ...scanned,
    ref: `e${scanned.index}`,
  }));
  expect(nodes[3]).toMatchObject({
    interactionBlocked: 'covered',
    coveredBy: { kind: 'tab-bar', persistentBar: true, scrollCanReveal: true },
  });
  expect(nodes[4]?.coveredBy).toMatchObject({ persistentBar: true, scrollCanReveal: true });
  expect(summarize(audit(nodes).findings)).toEqual([]);
});

test('keeps the covered-control finding for a row stuck under the floating tab bar when the list is scrolled to its end', () => {
  // The Pantry Recipes shape from #4763, but scrolled to its end: the full-viewport ScrollView
  // reports hidden content above only, so no scroll can move the last row up clear of the bar. The
  // occlusion scan therefore publishes no `scrollCanReveal` and the audit keeps the finding. The
  // occlusion scan produces the `coveredBy`, as in a real capture.
  const raw: RawSnapshotNode[] = [
    {
      index: 0,
      depth: 0,
      type: 'Application',
      role: 'UIApplication',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      parentIndex: 0,
      depth: 1,
      type: 'ScrollView',
      role: 'RCTEnhancedScrollView',
      subrole: 'UIScrollView',
      hiddenContentAbove: true,
      hittable: true,
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 2,
      parentIndex: 1,
      depth: 2,
      type: 'Button',
      role: 'RCTViewComponentView',
      label: 'Berry Overnight Oats, 5 minutes',
      hittable: true,
      rect: { x: 32, y: 805, width: 308, height: 69 },
    },
    {
      index: 3,
      parentIndex: 0,
      depth: 1,
      type: 'TabBar',
      role: 'UITabBar',
      label: 'Tab Bar',
      hittable: true,
      rect: { x: 0, y: 791, width: 402, height: 83 },
    },
  ];
  const nodes = annotateCoveredSnapshotNodes(raw, { producer: 'apple-runner' }).map((scanned) => ({
    ...scanned,
    ref: `e${scanned.index}`,
  }));
  expect(nodes[2]).toMatchObject({
    interactionBlocked: 'covered',
    coveredBy: { kind: 'tab-bar', persistentBar: true },
  });
  // The list is at its end: no hidden content below, so no scroll can reveal the row.
  expect(nodes[2]?.coveredBy?.scrollCanReveal).toBeUndefined();
  expect(summarize(audit(nodes).findings)).toEqual(['covered-control @e2']);
});

test('keeps the covered-control finding for a control in a horizontal carousel straddling the bar', () => {
  // The Android producer publishes `hiddenContentAbove`/`hiddenContentBelow` only for a vertical
  // scroller (`isVerticalScrollableNode` rejects `HorizontalScrollView`), so a horizontal carousel
  // that straddles the bar carries neither flag. With no scrollable ancestor that reports hidden
  // content, the scan publishes no `scrollCanReveal` and the audit keeps the finding. The occlusion
  // scan produces the `coveredBy`, as in a real capture.
  const raw: RawSnapshotNode[] = [
    { index: 0, depth: 0, type: 'Window', rect: { x: 0, y: 0, width: 402, height: 874 } },
    {
      index: 1,
      parentIndex: 0,
      depth: 1,
      type: 'android.widget.HorizontalScrollView',
      rect: { x: 0, y: 700, width: 402, height: 160 },
    },
    {
      index: 2,
      parentIndex: 1,
      depth: 2,
      type: 'Button',
      label: 'Buy now',
      hittable: true,
      rect: { x: 20, y: 805, width: 120, height: 50 },
    },
    {
      index: 3,
      parentIndex: 0,
      depth: 1,
      type: 'com.google.android.material.bottomnavigation.BottomNavigationView',
      hittable: true,
      rect: { x: 0, y: 791, width: 402, height: 83 },
    },
  ];
  const nodes = annotateCoveredSnapshotNodes(raw, { producer: 'android-uiautomator' }).map(
    (scanned) => ({
      ...scanned,
      ref: `e${scanned.index}`,
    }),
  );
  expect(nodes[2]).toMatchObject({
    interactionBlocked: 'covered',
    coveredBy: { persistentBar: true },
  });
  // The scroll axis is horizontal, so the Android producer publishes no hidden-content flags for
  // the carousel and no scroll can move the button off the bottom bar's edge.
  expect(nodes[2]?.coveredBy?.scrollCanReveal).toBeUndefined();
  expect(summarize(audit(nodes, ANDROID).findings)).toEqual(['covered-control @e2']);
});

test('drops the covered-control finding for a RecyclerView row under a BottomNavigationView with no root node', () => {
  // The Android shape the reviewer asked for (#4763 on Android): android-uiautomator emits no
  // Application or Window root, so nothing here resolves a viewport. A RecyclerView that reports
  // `hiddenContentBelow` (the helper's canScrollForward) reaches above the BottomNavigationView
  // cover, so a scroll reveals the covered row: the scan publishes `scrollCanReveal` and the audit
  // reports nothing. The occlusion scan produces the `coveredBy`, as in a real capture.
  const raw: RawSnapshotNode[] = [
    {
      index: 0,
      depth: 0,
      type: 'androidx.recyclerview.widget.RecyclerView',
      scrollable: true,
      hiddenContentBelow: true,
      rect: { x: 0, y: 128, width: 402, height: 746 },
    },
    {
      index: 1,
      parentIndex: 0,
      depth: 1,
      type: 'android.widget.Button',
      label: 'Grilled asparagus salad',
      clickable: true,
      rect: { x: 16, y: 800, width: 370, height: 72 },
    },
    {
      index: 2,
      depth: 0,
      type: 'com.google.android.material.bottomnavigation.BottomNavigationView',
      clickable: true,
      rect: { x: 0, y: 791, width: 402, height: 83 },
    },
  ];
  const nodes = annotateCoveredSnapshotNodes(raw, { producer: 'android-uiautomator' }).map(
    (scanned) => ({
      ...scanned,
      ref: `e${scanned.index}`,
    }),
  );
  expect(nodes[1]).toMatchObject({
    interactionBlocked: 'covered',
    coveredBy: { kind: 'bottom-navigation', persistentBar: true, scrollCanReveal: true },
  });
  expect(summarize(audit(nodes, ANDROID).findings)).toEqual([]);
});

test('keeps the finding when the strip above the bottom bar is shorter than the covered row', () => {
  // The list scrolls, but only 31dp of it sits above the bar, so no scroll can bring the 72dp row
  // fully into view: the scan publishes no `scrollCanReveal` and the audit keeps the finding.
  const raw: RawSnapshotNode[] = [
    {
      index: 0,
      depth: 0,
      type: 'androidx.recyclerview.widget.RecyclerView',
      scrollable: true,
      hiddenContentBelow: true,
      rect: { x: 0, y: 760, width: 402, height: 114 },
    },
    {
      index: 1,
      parentIndex: 0,
      depth: 1,
      type: 'android.widget.Button',
      label: 'Grilled asparagus salad',
      clickable: true,
      rect: { x: 16, y: 800, width: 370, height: 72 },
    },
    {
      index: 2,
      depth: 0,
      type: 'com.google.android.material.bottomnavigation.BottomNavigationView',
      clickable: true,
      rect: { x: 0, y: 791, width: 402, height: 83 },
    },
  ];
  const nodes = annotateCoveredSnapshotNodes(raw, { producer: 'android-uiautomator' }).map(
    (scanned) => ({ ...scanned, ref: `e${scanned.index}` }),
  );
  expect(nodes[1]).toMatchObject({
    interactionBlocked: 'covered',
    coveredBy: { persistentBar: true },
  });
  expect(nodes[1]?.coveredBy?.scrollCanReveal).toBeUndefined();
  expect(summarize(audit(nodes, ANDROID).findings)).toEqual(['covered-control @e1']);
});
