import type { Rect } from '@agent-device/kernel/snapshot';
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { PROPERTY_RUNS } from '../../../__tests__/test-utils/property-arbitraries.ts';
import {
  createAndroidSnapshotPresentationNode,
  effectiveAndroidRect,
  serializeAndroidRegularPresentationNode,
} from '../snapshot-presentation.ts';
import { parseUiHierarchy } from './ui-hierarchy-fixtures.ts';

const rectArb = fc.record({
  x: fc.integer({ min: -500, max: 500 }),
  y: fc.integer({ min: -500, max: 500 }),
  width: fc.integer({ min: -20, max: 500 }),
  height: fc.integer({ min: -20, max: 500 }),
});

const positiveRectArb = fc.record({
  x: fc.integer({ min: -500, max: 500 }),
  y: fc.integer({ min: -500, max: 500 }),
  width: fc.integer({ min: 1, max: 500 }),
  height: fc.integer({ min: 1, max: 500 }),
});

test('regular Android snapshots publish cumulative effective geometry while raw keeps reported bounds', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][400,800]" window-bounds="[0,0][400,800]" visible-to-user="true">
    <node class="android.widget.ScrollView" bounds="[0,100][300,500]" scrollable="true" visible-to-user="true">
      <node class="android.widget.ScrollView" bounds="[50,150][250,350]" scrollable="true" visible-to-user="true">
        <node class="android.widget.Button" text="Partially visible" bounds="[200,300][320,380]" clickable="true" visible-to-user="true" />
        <node class="android.widget.Button" text="Outside nested scroll" bounds="[260,360][380,420]" clickable="true" visible-to-user="true" />
      </node>
    </node>
  </node>
</hierarchy>`;

  const regular = parseUiHierarchy(xml, 800, {});
  const raw = parseUiHierarchy(xml, 800, { raw: true });

  expect(regular.nodes.find((node) => node.label === 'Partially visible')).toMatchObject({
    rect: { x: 200, y: 300, width: 50, height: 50 },
    hittable: true,
  });
  expect(regular.nodes.find((node) => node.label === 'Outside nested scroll')).toMatchObject({
    rect: { x: 260, y: 360, width: 0, height: 0 },
    hittable: undefined,
  });
  expect(raw.nodes.find((node) => node.label === 'Partially visible')).toMatchObject({
    rect: { x: 200, y: 300, width: 120, height: 80 },
    hittable: true,
  });
  expect(raw.nodes.find((node) => node.label === 'Outside nested scroll')).toMatchObject({
    rect: { x: 260, y: 360, width: 120, height: 60 },
    hittable: true,
  });
});

test('regular Android snapshots clip descendants to their owning window', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][400,800]" window-bounds="[0,0][400,800]" window-index="0" window-type="1" window-layer="1" window-active="true" window-focused="true" visible-to-user="true">
    <node class="android.widget.Button" text="Main action" bounds="[20,20][180,80]" clickable="true" visible-to-user="true" />
  </node>
  <node class="android.widget.FrameLayout" bounds="[100,100][300,300]" window-bounds="[100,100][300,300]" window-index="1" window-type="2" window-layer="2" window-active="true" window-focused="true" visible-to-user="true">
    <node class="android.widget.Button" text="Outside dialog" bounds="[120,320][180,380]" clickable="true" visible-to-user="true" />
  </node>
</hierarchy>`;

  const regular = parseUiHierarchy(xml, 800, {});
  const dialogAction = regular.nodes.find((node) => node.label === 'Outside dialog');

  expect(dialogAction).toMatchObject({
    rect: { x: 120, y: 320, width: 0, height: 0 },
    hittable: undefined,
  });
});

test('property: effective Android geometry stays inside every positive clip and never upgrades actionability', () => {
  fc.assert(
    fc.property(rectArb, positiveRectArb, positiveRectArb, (reported, viewport, ancestorClip) => {
      const effective = effectiveAndroidRect(reported, viewport, ancestorClip);
      const raw = { index: 0, depth: 0, rect: reported, hittable: true as const };
      const carrier = createAndroidSnapshotPresentationNode(raw, effective);
      const regular = serializeAndroidRegularPresentationNode(carrier);

      expect(carrier.raw.rect).toEqual(reported);
      expect(regular.rect).toEqual(effective);
      if (effective && effective.width > 0 && effective.height > 0) {
        expect(rectContains(viewport, effective)).toBe(true);
        expect(rectContains(ancestorClip, effective)).toBe(true);
        expect(regular.hittable).toBe(true);
      } else {
        expect(regular.hittable).toBeUndefined();
      }
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + Math.max(0, outer.width) &&
    inner.y + inner.height <= outer.y + Math.max(0, outer.height)
  );
}
