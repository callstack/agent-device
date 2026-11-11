import { attachRefs } from '@agent-device/kernel/snapshot';
import { createSnapshotVisibility } from '@agent-device/contracts/snapshot';
import { readSnapshotNodeInteractionBounds } from '@agent-device/kernel/rect-center';
import { expect, test } from 'vitest';
import fc from 'fast-check';
import { parseUiHierarchy } from './ui-hierarchy-fixtures.ts';

function hierarchy(
  options: {
    packageName?: string;
    visible?: boolean;
    layer?: number;
    barBounds?: string;
    appBounds?: string;
    rowBounds?: string;
    resourceId?: string;
    barReportedBounds?: string;
  } = {},
): string {
  const packageName = options.packageName ?? 'com.google.android.apps.nexuslauncher';
  const appBounds = options.appBounds ?? '[0,0][1080,2400]';
  const barBounds = options.barBounds ?? '[0,2274][1080,2400]';
  return `<hierarchy>
    <node class="android.widget.FrameLayout" package="${packageName}" bounds="${barBounds}" window-bounds="${barBounds}" window-index="0" window-type="3" window-layer="${options.layer ?? 10}" visible-to-user="${options.visible ?? true}">
      <node class="android.widget.FrameLayout" package="${packageName}" resource-id="${options.resourceId ?? `${packageName}:id/navbuttons_view`}" bounds="${options.barReportedBounds ?? barBounds}" visible-to-user="true">
        <node class="android.widget.ImageView" package="${packageName}" content-desc="Home" bounds="[434,2279][644,2395]" clickable="true" visible-to-user="true" />
      </node>
    </node>
    <node class="android.widget.FrameLayout" package="dev.e2e.benchmark" bounds="${appBounds}" window-bounds="${appBounds}" window-index="1" window-type="1" window-layer="1" visible-to-user="true">
      <node class="android.widget.ScrollView" package="dev.e2e.benchmark" bounds="${appBounds}" scrollable="true" visible-to-user="true">
        <node class="android.view.ViewGroup" package="dev.e2e.benchmark" resource-id="item-137" content-desc="Item 137" bounds="${options.rowBounds ?? '[0,2259][1080,2390]'}" clickable="true" visible-to-user="true" />
        <node class="android.view.ViewGroup" package="dev.e2e.benchmark" resource-id="item-138" content-desc="Item 138" bounds="[0,2305][1080,2400]" clickable="true" visible-to-user="true" />
      </node>
    </node>
  </hierarchy>`;
}

test('a scrolled row uses only the visible strip above launcher-owned navigation, while Home remains actionable', () => {
  const snapshot = parseUiHierarchy(hierarchy(), undefined, {});

  expect(snapshot.nodes.find((node) => node.identifier === 'item-137')).toMatchObject({
    rect: { x: 0, y: 2259, width: 1080, height: 15 },
    hittable: true,
  });
  expect(snapshot.nodes.find((node) => node.identifier === 'item-138')).toBeUndefined();
  expect(snapshot.nodes.find((node) => node.label === 'Home')).toMatchObject({
    rect: { x: 434, y: 2279, width: 210, height: 116 },
    hittable: true,
  });
});

test('raw Android snapshots retain bounds behind system navigation', () => {
  const snapshot = parseUiHierarchy(hierarchy(), undefined, { raw: true });

  expect(snapshot.nodes.find((node) => node.identifier === 'item-137')).toMatchObject({
    rect: { x: 0, y: 2259, width: 1080, height: 131 },
  });
  expect(snapshot.nodes.find((node) => node.identifier === 'item-138')).toBeDefined();
});

test('raw snapshots retain measured input bounds without changing or serializing reported rectangles', () => {
  const snapshot = parseUiHierarchy(hierarchy(), undefined, { raw: true });
  const target = snapshot.nodes.find((node) => node.identifier === 'item-137')!;
  const covered = snapshot.nodes.find((node) => node.identifier === 'item-138')!;
  const bounds = { x: 0, y: 0, width: 1080, height: 2274 };
  expect(readSnapshotNodeInteractionBounds(target)).toEqual(bounds);
  expect(readSnapshotNodeInteractionBounds(covered)).toEqual(bounds);
  expect(JSON.parse(JSON.stringify(target)).rect).toEqual({
    x: 0,
    y: 2259,
    width: 1080,
    height: 131,
  });
  expect(readSnapshotNodeInteractionBounds({ ...target })).toEqual(bounds);
});

function mixedWindowHierarchy(
  barFirst: boolean,
  contentPackage: string,
  scrollableRoot: boolean,
): string {
  const bar = `<node class="android.widget.FrameLayout" package="com.google.android.apps.nexuslauncher" resource-id="com.google.android.apps.nexuslauncher:id/navbuttons_view" bounds="[0,2274][1080,2400]" visible-to-user="true">
    <node class="android.widget.ImageView" package="com.google.android.apps.nexuslauncher" content-desc="Home" bounds="[434,2279][644,2395]" clickable="true" visible-to-user="true" />
    <node class="android.view.ViewGroup" package="dev.e2e.benchmark" resource-id="embedded-content" bounds="[0,2305][1080,2400]" clickable="true" visible-to-user="true" />
  </node>`;
  const content = `<node class="android.widget.ScrollView" package="${contentPackage}" bounds="[0,0][1080,2400]" scrollable="true" visible-to-user="true">
    <node class="android.view.ViewGroup" package="${contentPackage}" resource-id="item-137" bounds="[0,2259][1080,2390]" clickable="true" visible-to-user="true" />
    <node class="android.view.ViewGroup" package="${contentPackage}" resource-id="item-138" bounds="[0,2305][1080,2400]" clickable="true" visible-to-user="true" />
  </node>`;
  return `<hierarchy><node class="${scrollableRoot ? 'android.widget.ScrollView' : 'android.widget.FrameLayout'}" scrollable="${scrollableRoot}" package="com.google.android.apps.nexuslauncher" bounds="[0,0][1080,2400]" window-bounds="[0,0][1080,2400]" window-layer="10" visible-to-user="true">${barFirst ? bar + content : content + bar}</node></hierarchy>`;
}

for (const [barFirst, scrollableRoot] of [
  [true, false],
  [false, false],
  [true, true],
  [false, true],
] as const) {
  test.each(['dev.e2e.benchmark', 'com.google.android.apps.nexuslauncher'])(
    `mixed window clips content branches and preserves only system-bar descendants: barFirst=${barFirst}, scrollableRoot=${scrollableRoot}, owner=%s`,
    (contentPackage) => {
      const xml = mixedWindowHierarchy(barFirst, contentPackage, scrollableRoot);
      const regular = parseUiHierarchy(xml, undefined, {});
      const raw = parseUiHierarchy(xml, undefined, { raw: true });
      const bounds = { x: 0, y: 0, width: 1080, height: 2274 };
      expect(regular.nodes.find((n) => n.identifier === 'item-137')?.rect).toEqual({
        x: 0,
        y: 2259,
        width: 1080,
        height: 15,
      });
      expect(regular.nodes.find((n) => n.identifier === 'item-138')).toBeUndefined();
      expect(regular.nodes.find((n) => n.identifier === 'embedded-content')).toBeUndefined();
      for (const identifier of ['item-137', 'item-138', 'embedded-content']) {
        const node = raw.nodes.find((n) => n.identifier === identifier)!;
        expect(readSnapshotNodeInteractionBounds(node)).toEqual(bounds);
      }
      for (const snapshot of [regular, raw]) {
        const home = snapshot.nodes.find((n) => n.label === 'Home')!;
        expect(home).toMatchObject({
          rect: { x: 434, y: 2279, width: 210, height: 116 },
          hittable: true,
          systemBar: 'navigation',
        });
        expect(readSnapshotNodeInteractionBounds(home)).toBeUndefined();
        const addressable = attachRefs(snapshot.nodes);
        const barControl = addressable.find((n) => n.label === 'Home')!;
        expect(createSnapshotVisibility(addressable).isVisibleOnScreen(barControl)).toBe(true);
      }
    },
  );
}

test('shared scroll ancestry preserves both status and navigation branches', () => {
  const status = `<node class="android.widget.FrameLayout" package="com.android.systemui" resource-id="com.android.systemui:id/status_bar" bounds="[0,0][1080,132]" visible-to-user="true"><node class="android.widget.TextView" package="com.android.systemui" text="Clock" bounds="[42,40][122,80]" visible-to-user="true" /></node>`;
  const xml = mixedWindowHierarchy(true, 'dev.e2e.benchmark', true).replace(
    '</node></hierarchy>',
    `${status}</node></hierarchy>`,
  );
  for (const raw of [false, true]) {
    const snapshot = parseUiHierarchy(xml, undefined, { raw });
    const row = snapshot.nodes.find((n) => n.identifier === 'item-137')!;
    expect(readSnapshotNodeInteractionBounds(row)).toEqual({
      x: 0,
      y: 132,
      width: 1080,
      height: 2142,
    });
    const clock = snapshot.nodes.find((n) => n.label === 'Clock')!;
    expect(clock).toMatchObject({
      rect: { x: 42, y: 40, width: 80, height: 40 },
      systemBar: 'status',
    });
    expect(readSnapshotNodeInteractionBounds(clock)).toBeUndefined();
    expect(snapshot.nodes.find((n) => n.label === 'Home')).toMatchObject({
      rect: { x: 434, y: 2279, width: 210, height: 116 },
      hittable: true,
    });
  }
});

test('a lower-layer window wholly inside navigation publishes no tappable app content', () => {
  const snapshot = parseUiHierarchy(
    hierarchy({
      appBounds: '[0,2300][1080,2380]',
      rowBounds: '[0,2310][1080,2370]',
    }),
    undefined,
    {},
  );

  expect(snapshot.nodes.find((node) => node.identifier === 'item-137')).toBeUndefined();
  expect(
    snapshot.nodes.filter((node) => node.bundleId === 'dev.e2e.benchmark' && node.hittable),
  ).toEqual([]);
});

test('an oversized bar wrapper is clipped to the bar window before it clips app content', () => {
  const snapshot = parseUiHierarchy(
    hierarchy({ barReportedBounds: '[0,0][1080,2400]' }),
    undefined,
    {},
  );

  expect(snapshot.nodes.find((node) => node.identifier === 'item-137')?.rect).toEqual({
    x: 0,
    y: 2259,
    width: 1080,
    height: 15,
  });
});

test('a measured status bar clips edge-to-edge app content', () => {
  const snapshot = parseUiHierarchy(
    hierarchy({
      packageName: 'com.android.systemui',
      resourceId: 'com.android.systemui:id/status_bar',
      barBounds: '[0,0][1080,132]',
      rowBounds: '[0,100][1080,200]',
    }),
    undefined,
    {},
  );

  expect(snapshot.nodes.find((node) => node.identifier === 'item-137')?.rect).toEqual({
    x: 0,
    y: 132,
    width: 1080,
    height: 68,
  });
});

test.each([true, false])(
  'adjoining status and navigation bars clip both edges regardless of window order: %s',
  (statusFirst) => {
    const navigation = hierarchy({
      appBounds: '[0,0][2400,1080]',
      barBounds: '[0,0][126,1080]',
      rowBounds: '[100,40][300,200]',
    });
    const status = `<node class="android.widget.FrameLayout" package="com.android.systemui" resource-id="com.android.systemui:id/status_bar" bounds="[126,0][2400,80]" window-bounds="[126,0][2400,80]" window-index="2" window-type="3" window-layer="11" visible-to-user="true" />`;
    const xml = statusFirst
      ? navigation.replace('<hierarchy>', `<hierarchy>${status}`)
      : navigation.replace('</hierarchy>', `${status}</hierarchy>`);
    const snapshot = parseUiHierarchy(xml, undefined, {});

    expect(snapshot.nodes.find((node) => node.identifier === 'item-137')?.rect).toEqual({
      x: 126,
      y: 80,
      width: 174,
      height: 120,
    });
  },
);

test.each([
  { packageName: 'dev.e2e.benchmark' },
  { visible: false },
  { layer: 0 },
  { barBounds: '[0,1000][1080,1126]' },
])('unproven or non-covering navigation does not clip app content: %j', (options) => {
  const snapshot = parseUiHierarchy(hierarchy(options), undefined, {});

  expect(snapshot.nodes.find((node) => node.identifier === 'item-137')).toMatchObject({
    rect: { x: 0, y: 2259, width: 1080, height: 131 },
  });
});

test.each([
  {
    barBounds: '[0,0][126,1080]',
    rowBounds: '[100,0][231,1080]',
    expected: { x: 126, y: 0, width: 105, height: 1080 },
  },
  {
    barBounds: '[2274,0][2400,1080]',
    rowBounds: '[2259,0][2390,1080]',
    expected: { x: 2259, y: 0, width: 15, height: 1080 },
  },
  {
    barBounds: '[0,0][2400,126]',
    rowBounds: '[0,100][2400,231]',
    expected: { x: 0, y: 126, width: 2400, height: 105 },
  },
])(
  'system navigation clips its measured edge after rotation: $barBounds',
  ({ expected, ...options }) => {
    const snapshot = parseUiHierarchy(
      hierarchy({ ...options, appBounds: '[0,0][2400,1080]' }),
      undefined,
      {},
    );

    expect(snapshot.nodes.find((node) => node.identifier === 'item-137')?.rect).toEqual(expected);
  },
);

const PROPERTY_RUNS = 100;
const systemBarOverlapArb = fc.record({
  x: fc.integer({ min: 0, max: 500 }),
  y: fc.integer({ min: 0, max: 500 }),
  width: fc.integer({ min: 200, max: 8000 }),
  height: fc.integer({ min: 200, max: 8000 }),
  barSize: fc.integer({ min: 1, max: 120 }),
  visibleSize: fc.integer({ min: 1, max: 19 }),
  side: fc.constantFrom('top', 'bottom', 'left', 'right'),
});

test('property: visible rectangles avoid measured bars at any device size, origin, and edge', () => {
  fc.assert(
    fc.property(systemBarOverlapArb, ({ x, y, width, height, barSize, visibleSize, side }) => {
      const right = x + width;
      const bottom = y + height;
      const bounds = (left: number, top: number, endX: number, endY: number) =>
        `[${left},${top}][${endX},${endY}]`;
      const cases = {
        bottom: {
          barBounds: bounds(x, bottom - barSize, right, bottom),
          rowBounds: bounds(x, bottom - barSize - visibleSize, right, bottom),
          expected: { x, y: bottom - barSize - visibleSize, width, height: visibleSize },
          reportedSize: 'height' as const,
        },
        top: {
          barBounds: bounds(x, y, right, y + barSize),
          rowBounds: bounds(x, y, right, y + barSize + visibleSize),
          expected: { x, y: y + barSize, width, height: visibleSize },
          reportedSize: 'height' as const,
        },
        left: {
          barBounds: bounds(x, y, x + barSize, bottom),
          rowBounds: bounds(x, y, x + barSize + visibleSize, bottom),
          expected: { x: x + barSize, y, width: visibleSize, height },
          reportedSize: 'width' as const,
        },
        right: {
          barBounds: bounds(right - barSize, y, right, bottom),
          rowBounds: bounds(right - barSize - visibleSize, y, right, bottom),
          expected: { x: right - barSize - visibleSize, y, width: visibleSize, height },
          reportedSize: 'width' as const,
        },
      };
      const { barBounds, rowBounds, expected, reportedSize } = cases[side];
      const xml = hierarchy({
        appBounds: bounds(x, y, right, bottom),
        barBounds,
        rowBounds,
      });
      const regular = parseUiHierarchy(xml, undefined, {});
      const raw = parseUiHierarchy(xml, undefined, { raw: true });
      const rect = regular.nodes.find((node) => node.identifier === 'item-137')!.rect!;

      expect(rect).toEqual(expected);
      const reported = raw.nodes.find((node) => node.identifier === 'item-137')!.rect!;
      expect(reported[reportedSize]).toBe(barSize + visibleSize);
    }),
    { numRuns: PROPERTY_RUNS },
  );
});
