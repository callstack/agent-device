import { test } from 'vitest';
import assert from 'node:assert/strict';
import { formatSnapshotText } from './snapshot.ts';
import { formatRole, formatSnapshotLine } from '../../snapshot/snapshot-lines.ts';
import { withNoColor } from '../../__tests__/test-utils/color.ts';

test('formatRole falls back for object prototype role names', () => {
  assert.equal(formatRole('constructor'), 'constructor');
  assert.equal(formatRole('__proto__'), '__proto__');
  assert.equal(formatRole('com.android.constructor'), 'constructor');
});

test('formatSnapshotText summarizes large text surfaces with preview metadata', () => {
  const text = withNoColor(() =>
    formatSnapshotText({
      nodes: [
        {
          ref: 'e1',
          index: 0,
          depth: 0,
          type: 'TextView',
          label: 'Editor for MainActivity.kt',
          value: 'package com.example.app\nclass MainActivity {}',
          enabled: true,
        },
      ],
      truncated: false,
    }),
  );
  assert.match(text, /@e1 \[text-view\] "Editor for MainActivity\.kt"/);
  assert.match(text, /\[editable\]/);
  assert.match(text, /\[preview:"package com\.example\.app class MainActivity \{\}"\]/);
  assert.match(text, /\[truncated\]/);
});

test('formatSnapshotText summarizes large Android TextView surfaces with preview metadata', () => {
  const text = withNoColor(() =>
    formatSnapshotText({
      nodes: [
        {
          ref: 'e1',
          index: 0,
          depth: 0,
          type: 'android.widget.TextView',
          label: 'line one\nline two\nline three',
          value: 'line one\nline two\nline three',
          enabled: true,
        },
      ],
      truncated: false,
    }),
  );
  assert.match(text, /@e1 \[text\] "Text view"/);
  assert.match(text, /\[preview:"line one line two line three"\]/);
  assert.match(text, /\[truncated\]/);
});

test('formatSnapshotText keeps web backend output as a full tree', () => {
  const text = withNoColor(() =>
    formatSnapshotText({
      backend: 'web',
      nodes: [
        {
          ref: 'e1',
          index: 0,
          depth: 0,
          role: 'document',
          rect: { x: 0, y: 0, width: 390, height: 844 },
        },
        {
          ref: 'e2',
          index: 1,
          depth: 1,
          parentIndex: 0,
          role: 'button',
          label: 'Offscreen web action',
          rect: { x: 0, y: 1200, width: 140, height: 44 },
        },
      ],
      truncated: false,
    }),
  );

  assert.match(text, /Snapshot: 2 nodes/);
  assert.match(text, /Offscreen web action/);
  assert.doesNotMatch(text, /visible nodes/);
  assert.doesNotMatch(text, /\[off-screen below\]/);
});

test('formatSnapshotText keeps linux-atspi backend output as a full tree', () => {
  const text = withNoColor(() =>
    formatSnapshotText({
      backend: 'linux-atspi',
      nodes: [
        {
          ref: 'e1',
          index: 0,
          depth: 0,
          type: 'Window',
          label: 'Browser',
          rect: { x: 0, y: 0, width: 390, height: 844 },
        },
        {
          ref: 'e2',
          index: 1,
          depth: 1,
          parentIndex: 0,
          role: 'button',
          label: 'Offscreen desktop action',
          rect: { x: 0, y: 1200, width: 140, height: 44 },
        },
      ],
      truncated: false,
    }),
  );

  assert.match(text, /Snapshot: 2 nodes/);
  assert.match(text, /Offscreen desktop action/);
  assert.doesNotMatch(text, /visible nodes/);
  assert.doesNotMatch(text, /\[off-screen below\]/);
});

test('formatSnapshotText omits unlabeled group wrappers while preserving labeled groups', () => {
  const text = withNoColor(() =>
    formatSnapshotText({
      nodes: [
        { ref: 'e1', index: 0, depth: 0, type: 'android.widget.FrameLayout' },
        { ref: 'e2', index: 1, depth: 1, parentIndex: 0, type: 'android.widget.LinearLayout' },
        { ref: 'e3', index: 2, depth: 2, parentIndex: 1, type: 'android.view.ViewGroup' },
        {
          ref: 'e14',
          index: 3,
          depth: 3,
          parentIndex: 2,
          type: 'android.widget.ScrollView',
        },
        {
          ref: 'e17',
          index: 4,
          depth: 4,
          parentIndex: 3,
          type: 'android.view.ViewGroup',
          label: 'HomePage',
        },
        {
          ref: 'e21',
          index: 5,
          depth: 5,
          parentIndex: 4,
          type: 'android.view.ViewGroup',
          label: 'Home',
        },
        {
          ref: 'e22',
          index: 6,
          depth: 5,
          parentIndex: 4,
          type: 'android.widget.Button',
          label: 'Search',
        },
      ],
      truncated: false,
    }),
  );

  assert.doesNotMatch(text, /@e1 \[group\]/);
  assert.doesNotMatch(text, /@e2 \[group\]/);
  assert.doesNotMatch(text, /@e3 \[group\]/);
  assert.match(text, /@e14 \[scroll-area\] \[scrollable\]/);
  assert.match(text, / {2}@e17 \[group\] "HomePage"/);
  assert.match(text, / {4}@e21 \[group\] "Home"/);
  assert.match(text, / {4}@e22 \[button\] "Search"/);
});

test('formatSnapshotText compresses visible indentation after hidden wrapper chains', () => {
  const text = withNoColor(() =>
    formatSnapshotText({
      nodes: [
        { ref: 'e1', index: 0, depth: 0, type: 'android.widget.FrameLayout' },
        { ref: 'e2', index: 1, depth: 1, parentIndex: 0, type: 'android.widget.ScrollView' },
        {
          ref: 'e3',
          index: 2,
          depth: 2,
          parentIndex: 1,
          type: 'android.widget.Button',
          label: 'Back',
        },
        { ref: 'e4', index: 3, depth: 3, parentIndex: 2, type: 'android.view.ViewGroup' },
        { ref: 'e5', index: 4, depth: 4, parentIndex: 3, type: 'android.widget.ImageView' },
      ],
      truncated: false,
    }),
  );

  assert.match(text, /^@e2 \[scroll-area\] \[scrollable\]$/m);
  assert.match(text, /^ {2}@e3 \[button\] "Back"$/m);
  assert.match(text, /^ {4}@e5 \[image\]$/m);
});

test('formatSnapshotText hides off-screen refs and adds compact discovery summaries', () => {
  const text = withNoColor(() =>
    formatSnapshotText({
      nodes: [
        {
          ref: 'e1',
          index: 0,
          depth: 0,
          type: 'Window',
          rect: { x: 0, y: 0, width: 390, height: 844 },
        },
        {
          ref: 'e2',
          index: 1,
          depth: 1,
          parentIndex: 0,
          type: 'XCUIElementTypeButton',
          label: 'Settings',
          rect: { x: 20, y: 120, width: 120, height: 44 },
          hittable: true,
        },
        {
          ref: 'e3',
          index: 2,
          depth: 1,
          parentIndex: 0,
          type: 'XCUIElementTypeButton',
          label: 'Privacy',
          rect: { x: 20, y: 1200, width: 120, height: 44 },
          hittable: true,
        },
        {
          ref: 'e4',
          index: 3,
          depth: 1,
          parentIndex: 0,
          type: 'XCUIElementTypeButton',
          label: 'Battery',
          rect: { x: 20, y: 1360, width: 120, height: 44 },
          hittable: true,
        },
      ],
      truncated: false,
    }),
  );

  assert.match(text, /Snapshot: 2 visible nodes \(4 total\)/);
  assert.match(text, /^@e1 \[window\]$/m);
  assert.match(text, /^ {2}@e2 \[button\] "Settings"$/m);
  assert.doesNotMatch(text, /@e3 \[button\] "Privacy"/);
  assert.doesNotMatch(text, /@e4 \[button\] "Battery"/);
  assert.match(text, /\[off-screen below\] 2 interactive items: "Privacy", "Battery"/);
});

test('formatSnapshotText keeps zero-height visible nodes out of off-screen summaries', () => {
  const text = withNoColor(() =>
    formatSnapshotText({
      nodes: [
        {
          ref: 'e1',
          index: 0,
          depth: 0,
          type: 'Window',
          rect: { x: 0, y: 0, width: 1440, height: 800 },
        },
        {
          ref: 'e2',
          index: 1,
          depth: 1,
          parentIndex: 0,
          type: 'android.widget.FrameLayout',
          rect: { x: 0, y: 0, width: 1440, height: 3120 },
        },
        {
          ref: 'e3',
          index: 2,
          depth: 2,
          parentIndex: 1,
          type: 'android.widget.Button',
          label: 'View',
          rect: { x: 264, y: 378, width: 972, height: 0 },
          hittable: true,
        },
        {
          ref: 'e4',
          index: 3,
          depth: 2,
          parentIndex: 1,
          type: 'android.widget.Button',
          label: 'Later',
          rect: { x: 264, y: 2200, width: 972, height: 120 },
          hittable: true,
        },
      ],
      truncated: false,
    }),
  );

  assert.match(text, /^ {2}@e3 \[button\] "View"$/m);
  assert.doesNotMatch(text, /\[off-screen above\].*"View"/);
  assert.match(text, /\[off-screen below\] 1 interactive item: "Later"/);
});

test('formatSnapshotText keeps ordinary repeated labels on separate rows', () => {
  const nodes = [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'android.widget.FrameLayout',
      rect: { x: 0, y: 0, width: 390, height: 844 },
    },
    ...Array.from({ length: 3 }, (_, index) => ({
      ref: `e${index + 2}`,
      index: index + 1,
      depth: 1,
      parentIndex: 0,
      type: 'android.widget.Button',
      label: 'Save',
      rect: { x: 24, y: 120 + index * 80, width: 120, height: 44 },
      hittable: true,
    })),
  ];
  const text = withNoColor(() =>
    formatSnapshotText({
      nodes,
      truncated: false,
      androidSnapshot: { backend: 'android-helper' },
    }),
  );

  assert.match(text, /Snapshot: 4 nodes/);
  assert.doesNotMatch(text, /Collapsed \d+ Android helper node/);
  assert.match(text, /@e2 \[button\] "Save"/);
  assert.match(text, /@e3 \[button\] "Save"/);
  assert.match(text, /@e4 \[button\] "Save"/);
});

test('formatSnapshotText renders explicit hidden scroll-area content hints', () => {
  const text = withNoColor(() =>
    formatSnapshotText({
      nodes: [
        {
          ref: 'e1',
          index: 0,
          depth: 0,
          type: 'Window',
          rect: { x: 0, y: 0, width: 390, height: 844 },
        },
        {
          ref: 'e2',
          index: 1,
          depth: 1,
          parentIndex: 0,
          type: 'android.widget.ScrollView',
          label: 'Messages',
          rect: { x: 0, y: 120, width: 390, height: 500 },
          hiddenContentAbove: true,
          hiddenContentBelow: true,
        },
        {
          ref: 'e3',
          index: 2,
          depth: 2,
          parentIndex: 1,
          type: 'android.widget.Button',
          label: 'Visible message',
          rect: { x: 20, y: 240, width: 350, height: 48 },
          hittable: true,
        },
      ],
      truncated: false,
    }),
  );

  assert.match(text, /Snapshot: 3 visible nodes/);
  assert.match(text, /^ {2}@e2 \[scroll-area\] "Messages" \[scrollable\]$/m);
  assert.match(text, /^ {4}\[content above scroll-area hidden\]$/m);
  assert.match(text, /^ {4}\[content below scroll-area hidden\]$/m);
  assert.ok(
    text.indexOf('[content above scroll-area hidden]') < text.indexOf('@e3 [button]'),
    'above hint should appear before visible scroll-area content',
  );
  assert.ok(
    text.indexOf('@e3 [button]') < text.indexOf('[content below scroll-area hidden]'),
    'below hint should appear after visible scroll-area content',
  );
});

test('formatSnapshotText keeps below scroll hints at the bottom when depth is flattened', () => {
  const text = withNoColor(() =>
    formatSnapshotText({
      nodes: [
        {
          ref: 'e1',
          index: 0,
          depth: 0,
          type: 'Window',
          rect: { x: 0, y: 0, width: 390, height: 844 },
        },
        {
          ref: 'e2',
          index: 1,
          depth: 1,
          parentIndex: 0,
          type: 'android.widget.ScrollView',
          label: 'Catalog',
          rect: { x: 0, y: 120, width: 390, height: 500 },
          hiddenContentAbove: true,
          hiddenContentBelow: true,
        },
        {
          ref: 'e3',
          index: 2,
          depth: 1,
          parentIndex: 1,
          type: 'android.widget.Button',
          label: 'Visible product',
          rect: { x: 20, y: 240, width: 350, height: 48 },
          hittable: true,
        },
      ],
      truncated: false,
    }),
  );

  assert.match(text, /^ {2}@e2 \[scroll-area\] "Catalog" \[scrollable\]$/m);
  assert.match(text, /^ {2}@e3 \[button\] "Visible product"$/m);
  assert.ok(
    text.indexOf('[content above scroll-area hidden]') < text.indexOf('@e3 [button]'),
    'above hint should stay at the top of the scroll-area',
  );
  assert.ok(
    text.indexOf('@e3 [button]') < text.indexOf('[content below scroll-area hidden]'),
    'below hint should stay at the bottom of the scroll-area',
  );
});

test('formatSnapshotText prefers payload visibility metadata for partial snapshot headers', () => {
  const text = withNoColor(() =>
    formatSnapshotText({
      nodes: [
        {
          ref: 'e1',
          index: 0,
          depth: 0,
          type: 'Window',
          rect: { x: 0, y: 0, width: 390, height: 844 },
        },
        {
          ref: 'e2',
          index: 1,
          depth: 1,
          parentIndex: 0,
          type: 'android.widget.Button',
          label: 'Visible',
          rect: { x: 20, y: 140, width: 160, height: 44 },
          hittable: true,
        },
      ],
      visibility: {
        partial: true,
        visibleNodeCount: 2,
        totalNodeCount: 5,
        reasons: ['offscreen-nodes'],
      },
      truncated: false,
    }),
  );

  assert.match(text, /Snapshot: 2 visible nodes \(5 total\)/);
});

test('formatSnapshotText renders hidden scroll-area content hints in flattened output', () => {
  const text = withNoColor(() =>
    formatSnapshotText(
      {
        nodes: [
          {
            ref: 'e1',
            index: 0,
            depth: 0,
            type: 'Window',
            rect: { x: 0, y: 0, width: 390, height: 844 },
          },
          {
            ref: 'e2',
            index: 1,
            depth: 1,
            parentIndex: 0,
            type: 'android.widget.ScrollView',
            label: 'Messages',
            rect: { x: 0, y: 120, width: 390, height: 500 },
            hiddenContentAbove: true,
            hiddenContentBelow: true,
          },
        ],
        truncated: false,
      },
      { flatten: true },
    ),
  );

  assert.match(text, /^@e2 \[scroll-area\] "Messages" \[scrollable\]$/m);
  assert.match(text, /^ {2}\[content above scroll-area hidden\]$/m);
  assert.match(text, /^ {2}\[content below scroll-area hidden\]$/m);
});

test('formatSnapshotText normalizes RecyclerView containers to list', () => {
  const text = withNoColor(() =>
    formatSnapshotText({
      nodes: [
        {
          ref: 'e1',
          index: 0,
          depth: 0,
          type: 'androidx.recyclerview.widget.RecyclerView',
          identifier: 'com.android.settings:id/recycler_view',
          rect: { x: 0, y: 0, width: 390, height: 500 },
          hiddenContentBelow: true,
        },
      ],
      truncated: false,
    }),
  );

  assert.match(text, /^@e1 \[list\]$/m);
  assert.match(text, /^ {2}\[content below list hidden\]$/m);
});

test('formatSnapshotText renders hidden-below list hints after visible descendants', () => {
  const text = withNoColor(() =>
    formatSnapshotText({
      nodes: [
        {
          ref: 'e1',
          index: 0,
          depth: 0,
          type: 'android.view.ViewGroup',
          rect: { x: 0, y: 0, width: 390, height: 844 },
        },
        {
          ref: 'e2',
          index: 1,
          depth: 1,
          parentIndex: 0,
          type: 'androidx.recyclerview.widget.RecyclerView',
          rect: { x: 0, y: 80, width: 390, height: 600 },
          hiddenContentBelow: true,
        },
        {
          ref: 'e3',
          index: 2,
          depth: 2,
          parentIndex: 1,
          type: 'android.widget.TextView',
          label: 'Text view',
          rect: { x: 16, y: 120, width: 358, height: 80 },
        },
        {
          ref: 'e4',
          index: 3,
          depth: 3,
          parentIndex: 2,
          type: 'android.widget.TextView',
          label: 'loadJSBundleFromAssets',
          rect: { x: 16, y: 140, width: 358, height: 40 },
        },
      ],
      truncated: false,
    }),
  );

  assert.match(text, /^@e2 \[list\]$/m);
  assert.match(text, /^ {2}@e3 \[text\] "Text view"$/m);
  assert.match(text, /^ {4}@e4 \[text\] "loadJSBundleFromAssets"$/m);
  assert.match(text, /^ {2}\[content below list hidden\]$/m);
  assert.ok(
    text.indexOf('@e4 [text] "loadJSBundleFromAssets"') <
      text.indexOf('[content below list hidden]'),
  );
});

test('formatSnapshotText marks visible scroll areas with hidden content above and below', () => {
  const text = withNoColor(() =>
    formatSnapshotText({
      nodes: [
        {
          ref: 'e1',
          index: 0,
          depth: 0,
          type: 'Window',
          rect: { x: 0, y: 0, width: 390, height: 844 },
        },
        {
          ref: 'e2',
          index: 1,
          depth: 1,
          parentIndex: 0,
          type: 'android.widget.ScrollView',
          label: 'Messages',
          rect: { x: 0, y: 120, width: 390, height: 500 },
        },
        {
          ref: 'e3',
          index: 2,
          depth: 2,
          parentIndex: 1,
          type: 'android.widget.Button',
          label: 'Earlier message',
          rect: { x: 20, y: 20, width: 350, height: 48 },
          hittable: true,
        },
        {
          ref: 'e4',
          index: 3,
          depth: 2,
          parentIndex: 1,
          type: 'android.widget.Button',
          label: 'Visible message',
          rect: { x: 20, y: 240, width: 350, height: 48 },
          hittable: true,
        },
        {
          ref: 'e5',
          index: 4,
          depth: 2,
          parentIndex: 1,
          type: 'android.widget.Button',
          label: 'Later message',
          rect: { x: 20, y: 700, width: 350, height: 48 },
          hittable: true,
        },
      ],
      truncated: false,
    }),
  );

  assert.match(text, /^ {2}@e2 \[scroll-area\] "Messages" \[scrollable\]$/m);
  assert.match(text, /^ {4}\[content above scroll-area hidden\]$/m);
  assert.match(text, /^ {4}\[content below scroll-area hidden\]$/m);
  assert.match(text, /^ {4}@e4 \[button\] "Visible message"$/m);
  assert.doesNotMatch(text, /\[off-screen above\].*"Earlier message"/);
  assert.doesNotMatch(text, /\[off-screen below\].*"Later message"/);
});

test('formatSnapshotText suppresses noisy system scroll-container labels', () => {
  const text = withNoColor(() =>
    formatSnapshotText({
      nodes: [
        {
          ref: 'e1',
          index: 0,
          depth: 0,
          type: 'Window',
          rect: { x: 0, y: 0, width: 390, height: 844 },
        },
        {
          ref: 'e2',
          index: 1,
          depth: 1,
          parentIndex: 0,
          type: 'ScrollView',
          label: 'Vertical scroll bar, 2 pages',
          rect: { x: 0, y: 100, width: 390, height: 600 },
          hiddenContentBelow: true,
        },
      ],
      truncated: false,
    }),
  );

  assert.match(text, /^ {2}@e2 \[scroll-area\] \[scrollable\]$/m);
  assert.match(text, /^ {4}\[content below scroll-area hidden\]$/m);
  assert.doesNotMatch(text, /Vertical scroll bar, 2 pages/);
});

test('formatSnapshotText prints snapshot warnings ahead of empty output', () => {
  const text = withNoColor(() =>
    formatSnapshotText({
      nodes: [],
      truncated: false,
      warnings: ['Interactive snapshot is empty after filtering 42 raw Android nodes.'],
    }),
  );
  assert.match(text, /Snapshot: 0 nodes/);
  assert.match(text, /Interactive snapshot is empty after filtering 42 raw Android nodes/);
});

test('formatSnapshotText hints to use plain screenshot for sparse snapshots', () => {
  const text = withNoColor(() =>
    formatSnapshotText({
      nodes: [
        {
          ref: 'e1',
          index: 0,
          depth: 0,
          type: 'Window',
          label: 'Main',
        },
      ],
      truncated: false,
    }),
  );

  assert.match(text, /Snapshot: 1 node/);
  assert.match(text, /Hint: sparse accessibility snapshot returned 1 node/);
  assert.match(text, /snapshot state is invalid or unavailable/i);
  assert.match(text, /Use plain screenshot, not screenshot --overlay-refs/);
  assert.match(text, /If screenshot shows the Home Screen or another app, run open/);
  assert.match(text, /retry snapshot -i on the next screen/);
});

test('formatSnapshotText suppresses sparse snapshot hint for scoped reads', () => {
  const text = withNoColor(() =>
    formatSnapshotText(
      {
        nodes: [
          {
            ref: 'e1',
            index: 0,
            depth: 0,
            type: 'StaticText',
            label: 'Expanded details',
          },
        ],
        truncated: false,
      },
      { scoped: true },
    ),
  );

  assert.doesNotMatch(text, /sparse accessibility snapshot/);
});

test('formatSnapshotText suppresses sparse snapshot hint for depth-limited reads', () => {
  const text = withNoColor(() =>
    formatSnapshotText(
      {
        nodes: [
          {
            ref: 'e1',
            index: 0,
            depth: 0,
            type: 'Application',
            label: 'Main',
          },
        ],
        truncated: false,
      },
      { depthLimited: true },
    ),
  );

  assert.doesNotMatch(text, /sparse accessibility snapshot/);
});

test('formatSnapshotText renders web textboxes as text fields and suppresses native sparse hint', () => {
  const text = withNoColor(() =>
    formatSnapshotText({
      nodes: [
        {
          ref: 'e1',
          index: 0,
          depth: 0,
          type: 'textbox',
          role: 'textbox',
          label: 'Email ',
          value: 'ada@example.com',
        },
      ],
      truncated: false,
      snapshotDiagnostics: { stats: { platform: 'web' } },
    }),
  );

  assert.match(text, /@e1 \[text-field\] "ada@example\.com"/);
  assert.doesNotMatch(text, /sparse accessibility snapshot/);
});

test('formatSnapshotText keeps flattened output and adds duplicate nav warning', () => {
  const nodes = Array.from({ length: 24 }, (_, index) => ({
    ref: `e${index + 1}`,
    index,
    depth: index === 0 ? 0 : 1,
    type: index === 0 ? 'android.widget.FrameLayout' : 'android.widget.Button',
    label: index === 0 ? 'Root' : 'Inbox',
    rect:
      index === 0
        ? { x: 0, y: 0, width: 1080, height: 2400 }
        : { x: 20, y: 40, width: 300, height: 48 },
    hittable: index !== 0,
    enabled: true,
  }));
  const text = withNoColor(() =>
    formatSnapshotText({ nodes, truncated: false }, { flatten: true }),
  );
  assert.match(text, /Warning: possible repeated nav subtree detected\./);
  assert.match(text, /@e2 \[button\] "Inbox"/);
});

test('formatSnapshotLine keeps snapshot-only metadata off the default formatter path', () => {
  const line = formatSnapshotLine(
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'TextView',
      label: 'Editor for MainActivity.kt',
      value: 'package com.example.app\nclass MainActivity {}',
      enabled: true,
      selected: true,
    },
    0,
    false,
  );
  assert.doesNotMatch(line, /\[selected\]/);
  assert.doesNotMatch(line, /\[editable\]/);
  assert.doesNotMatch(line, /\[scrollable\]/);
});
