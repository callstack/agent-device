import { test } from 'vitest';
import assert from 'node:assert/strict';
import { formatSnapshotText } from './snapshot.ts';
import { withNoColor } from '../../__tests__/test-utils/color.ts';

test('formatSnapshotText collapses Android helper nodes in agent-facing output', () => {
  const nodes = [
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
      label: 'Alice, Today, filed the expense',
      rect: { x: 0, y: 420, width: 390, height: 96 },
      hittable: true,
    },
    {
      ref: 'e3',
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'android.widget.Button',
      label: 'alice@example.com',
      rect: { x: 16, y: 432, width: 48, height: 48 },
      hittable: true,
    },
    {
      ref: 'e4',
      index: 3,
      depth: 2,
      parentIndex: 1,
      type: 'android.widget.Button',
      label: 'alice@example.com',
      rect: { x: 80, y: 432, width: 120, height: 48 },
      hittable: true,
    },
    {
      ref: 'e5',
      index: 4,
      depth: 3,
      parentIndex: 3,
      type: 'android.widget.TextView',
      label: 'Alice',
      rect: { x: 80, y: 432, width: 120, height: 48 },
    },
    {
      ref: 'e6',
      index: 5,
      depth: 1,
      parentIndex: 0,
      type: 'android.widget.Button',
      label: 'Invisible stale action',
      rect: { x: 0, y: 160, width: 390, height: 0 },
      hittable: true,
    },
    {
      ref: 'e7',
      index: 6,
      depth: 1,
      parentIndex: 0,
      type: 'android.widget.EditText',
      label: 'Write something...',
      identifier: 'composer',
      rect: { x: 72, y: 760, width: 240, height: 44 },
      hittable: true,
    },
    {
      ref: 'e8',
      index: 7,
      depth: 1,
      parentIndex: 0,
      type: 'android.view.View',
      label: 'Dashboard',
      rect: { x: 0, y: 720, width: 78, height: 96 },
      hittable: true,
    },
    {
      ref: 'e9',
      index: 8,
      depth: 2,
      parentIndex: 7,
      type: 'android.widget.TextView',
      label: 'Dashboard',
      rect: { x: 20, y: 780, width: 40, height: 24 },
    },
    {
      ref: 'e10',
      index: 9,
      depth: 1,
      parentIndex: 0,
      type: 'android.view.View',
      label: 'Messages. Your review is required',
      rect: { x: 78, y: 720, width: 78, height: 96 },
      hittable: true,
    },
    {
      ref: 'e11',
      index: 10,
      depth: 2,
      parentIndex: 9,
      type: 'android.widget.TextView',
      label: 'Messages',
      rect: { x: 98, y: 780, width: 40, height: 24 },
    },
    {
      ref: 'e12',
      index: 11,
      depth: 1,
      parentIndex: 0,
      type: 'android.view.View',
      label: 'Billing',
      rect: { x: 156, y: 720, width: 78, height: 96 },
      hittable: true,
    },
    {
      ref: 'e13',
      index: 12,
      depth: 2,
      parentIndex: 11,
      type: 'android.widget.TextView',
      label: 'Billing',
      rect: { x: 176, y: 780, width: 40, height: 24 },
    },
    {
      ref: 'e14',
      index: 13,
      depth: 1,
      parentIndex: 0,
      type: 'android.view.View',
      label: 'Profile, My settings.',
      rect: { x: 312, y: 720, width: 78, height: 96 },
      hittable: true,
    },
    {
      ref: 'e15',
      index: 14,
      depth: 2,
      parentIndex: 13,
      type: 'android.widget.TextView',
      label: 'Profile',
      rect: { x: 332, y: 780, width: 40, height: 24 },
    },
  ];
  const text = withNoColor(() =>
    formatSnapshotText({
      nodes,
      truncated: false,
      androidSnapshot: { backend: 'android-helper' },
    }),
  );

  assert.match(text, /Snapshot: 8 visible nodes \(15 total\)/);
  assert.match(text, /Collapsed 7 Android helper nodes from the agent-facing text snapshot/);
  assert.match(text, /@e3 \[button\] "alice@example\.com"/);
  assert.doesNotMatch(text, /@e4 \[button\] "alice@example\.com"/);
  assert.doesNotMatch(text, /Invisible stale action/);
  assert.match(text, /@e8 \[group\] "Dashboard"/);
  assert.match(text, /@e10 \[group\] "Messages\. Your review is required"/);
  assert.match(text, /@e12 \[group\] "Billing"/);
  assert.match(text, /@e14 \[group\] "Profile, My settings\."/);
  assert.doesNotMatch(text, /@e11 \[text\] "Messages"/);
  assert.doesNotMatch(text, /@e15 \[text\] "Profile"/);
  assert.doesNotMatch(text, /possible repeated nav subtree/);

  const raw = withNoColor(() =>
    formatSnapshotText(
      {
        nodes,
        truncated: false,
        androidSnapshot: { backend: 'android-helper' },
      },
      { raw: true },
    ),
  );
  assert.match(raw, /"Invisible stale action"/);
  assert.match(raw, /"Messages\. Your review is required"/);
});

test('formatSnapshotText promotes Android helper unlabeled action rows', () => {
  const nodes = [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'android.widget.FrameLayout',
      rect: { x: 0, y: 0, width: 390, height: 844 },
    },
    {
      ref: 'e2',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'android.widget.LinearLayout',
      rect: { x: 0, y: 160, width: 390, height: 72 },
      hittable: true,
    },
    {
      ref: 'e3',
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'android.widget.ImageView',
      rect: { x: 24, y: 176, width: 32, height: 32 },
    },
    {
      ref: 'e4',
      index: 3,
      depth: 2,
      parentIndex: 1,
      type: 'android.widget.TextView',
      label: 'Network & internet',
      rect: { x: 72, y: 168, width: 260, height: 28 },
    },
    {
      ref: 'e5',
      index: 4,
      depth: 2,
      parentIndex: 1,
      type: 'android.widget.TextView',
      label: 'Mobile, Wi-Fi, hotspot',
      rect: { x: 72, y: 198, width: 260, height: 24 },
    },
  ];
  const text = withNoColor(() =>
    formatSnapshotText({
      nodes,
      truncated: false,
      androidSnapshot: { backend: 'android-helper' },
    }),
  );

  assert.match(text, /Snapshot: 2 visible nodes \(5 total\)/);
  assert.match(text, /Collapsed 3 Android helper nodes from the agent-facing text snapshot/);
  assert.match(text, /@e2 \[group\] "Network & internet, Mobile, Wi-Fi, hotspot"/);
  assert.doesNotMatch(text, /@e4 \[text\] "Network & internet"/);
  assert.doesNotMatch(text, /@e5 \[text\] "Mobile, Wi-Fi, hotspot"/);

  const raw = withNoColor(() =>
    formatSnapshotText(
      {
        nodes,
        truncated: false,
        androidSnapshot: { backend: 'android-helper' },
      },
      { raw: true },
    ),
  );
  assert.match(raw, /"ref":"e4"/);
  assert.match(raw, /"Network & internet"/);
  assert.match(raw, /"Mobile, Wi-Fi, hotspot"/);
});

test('formatSnapshotText promotes Android Compose leaf-view semantics to their action', () => {
  const text = withNoColor(() =>
    formatSnapshotText({
      nodes: [
        {
          ref: 'e1',
          index: 0,
          depth: 0,
          type: 'android.view.View',
          rect: { x: 923, y: 158, width: 126, height: 126 },
          hittable: true,
        },
        {
          ref: 'e2',
          index: 1,
          depth: 1,
          parentIndex: 0,
          type: 'android.view.View',
          label: 'Start a call',
          rect: { x: 954, y: 189, width: 63, height: 63 },
        },
      ],
      truncated: false,
      androidSnapshot: { backend: 'android-helper' },
    }),
  );

  assert.match(text, /Snapshot: 1 visible nodes \(2 total\)/);
  assert.match(text, /@e1 \[group\] "Start a call"/);
  assert.doesNotMatch(text, /@e2/);
});

test('formatSnapshotText keeps passive row descendants that were not promoted', () => {
  const nodes = [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'android.widget.FrameLayout',
      rect: { x: 0, y: 0, width: 390, height: 844 },
    },
    {
      ref: 'e2',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'android.widget.LinearLayout',
      rect: { x: 0, y: 160, width: 390, height: 72 },
      hittable: true,
    },
    {
      ref: 'e3',
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'android.widget.TextView',
      label: 'Inside row',
      rect: { x: 72, y: 176, width: 260, height: 28 },
    },
    {
      ref: 'e4',
      index: 3,
      depth: 2,
      parentIndex: 1,
      type: 'android.widget.TextView',
      label: 'Outside parent bounds',
      rect: { x: 72, y: 260, width: 260, height: 28 },
    },
  ];
  const text = withNoColor(() =>
    formatSnapshotText({
      nodes,
      truncated: false,
      androidSnapshot: { backend: 'android-helper' },
    }),
  );

  assert.match(text, /Snapshot: 3 visible nodes \(4 total\)/);
  assert.match(text, /Collapsed 1 Android helper node from the agent-facing text snapshot/);
  assert.match(text, /@e2 \[group\] "Inside row"/);
  assert.doesNotMatch(text, /@e3 \[text\] "Inside row"/);
  assert.match(text, /@e4 \[text\] "Outside parent bounds"/);
});

test('formatSnapshotText collapses adjacent React Native row noise in Android helper output', () => {
  const nodes = [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'android.widget.FrameLayout',
      rect: { x: 0, y: 0, width: 390, height: 844 },
    },
    {
      ref: 'e2',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'androidx.recyclerview.widget.RecyclerView',
      label: 'Messages',
      rect: { x: 0, y: 80, width: 390, height: 580 },
    },
    {
      ref: 'e3',
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'android.widget.Button',
      label: 'Adam, 9:41 AM, Hello from Adam',
      rect: { x: 12, y: 120, width: 366, height: 96 },
      hittable: true,
    },
    {
      ref: 'e4',
      index: 3,
      depth: 3,
      parentIndex: 2,
      type: 'android.widget.ImageView',
      label: 'Adam',
      rect: { x: 20, y: 132, width: 40, height: 40 },
    },
    {
      ref: 'e5',
      index: 4,
      depth: 3,
      parentIndex: 2,
      type: 'android.widget.Button',
      label: 'Adam',
      rect: { x: 20, y: 132, width: 40, height: 40 },
      hittable: true,
    },
    {
      ref: 'e6',
      index: 5,
      depth: 3,
      parentIndex: 2,
      type: 'android.widget.TextView',
      label: 'Hello from Adam',
      rect: { x: 72, y: 160, width: 250, height: 32 },
    },
    {
      ref: 'e7',
      index: 6,
      depth: 3,
      parentIndex: 2,
      type: 'android.widget.Button',
      label: 'Hello from Adam',
      rect: { x: 72, y: 160, width: 250, height: 32 },
      hittable: true,
    },
    {
      ref: 'e8',
      index: 7,
      depth: 1,
      parentIndex: 0,
      type: 'android.widget.EditText',
      label: 'Write a message...',
      identifier: 'composer',
      rect: { x: 64, y: 716, width: 248, height: 48 },
      hittable: true,
    },
    {
      ref: 'e9',
      index: 8,
      depth: 1,
      parentIndex: 0,
      type: 'android.widget.Button',
      label: 'Send',
      rect: { x: 320, y: 716, width: 48, height: 48 },
      hittable: true,
    },
    {
      ref: 'e10',
      index: 9,
      depth: 1,
      parentIndex: 0,
      type: 'android.widget.Button',
      label: 'Create expense',
      rect: { x: 20, y: 660, width: 160, height: 40 },
      hittable: true,
    },
  ];
  const text = withNoColor(() =>
    formatSnapshotText({
      nodes,
      truncated: false,
      androidSnapshot: { backend: 'android-helper' },
    }),
  );

  assert.match(text, /Snapshot: 6 visible nodes \(10 total\)/);
  assert.match(text, /Collapsed 4 Android helper nodes from the agent-facing text snapshot/);
  assert.match(text, /@e3 \[button\] "Adam, 9:41 AM, Hello from Adam"/);
  assert.doesNotMatch(text, /\[also text\]/);
  assert.doesNotMatch(text, /@e4 \[image\] "Adam"/);
  assert.doesNotMatch(text, /@e5 \[button\] "Adam"/);
  assert.doesNotMatch(text, /@e6 \[text\] "Hello from Adam"/);
  assert.doesNotMatch(text, /@e7 \[button\] "Hello from Adam"/);
  assert.match(text, /@e8 \[text-field\] "Write a message\.\.\." \[editable\]/);
  assert.match(text, /@e9 \[button\] "Send"/);
  assert.match(text, /@e10 \[button\] "Create expense"/);

  const raw = withNoColor(() =>
    formatSnapshotText(
      {
        nodes,
        truncated: false,
        androidSnapshot: { backend: 'android-helper' },
      },
      { raw: true },
    ),
  );
  assert.match(raw, /"ref":"e5"/);
  assert.match(raw, /"ref":"e7"/);
});

test('formatSnapshotText keeps single repeated child control in Android helper output', () => {
  const text = withNoColor(() =>
    formatSnapshotText({
      nodes: [
        {
          ref: 'e1',
          index: 0,
          depth: 0,
          type: 'android.widget.FrameLayout',
          rect: { x: 0, y: 0, width: 390, height: 844 },
        },
        {
          ref: 'e2',
          index: 1,
          depth: 1,
          parentIndex: 0,
          type: 'android.widget.Button',
          label: 'Send message',
          rect: { x: 16, y: 700, width: 358, height: 56 },
          hittable: true,
        },
        {
          ref: 'e3',
          index: 2,
          depth: 2,
          parentIndex: 1,
          type: 'android.widget.Button',
          label: 'Send',
          rect: { x: 290, y: 708, width: 64, height: 40 },
          hittable: true,
        },
      ],
      truncated: false,
      androidSnapshot: { backend: 'android-helper' },
    }),
  );

  assert.match(text, /Snapshot: 3 nodes/);
  assert.doesNotMatch(text, /Collapsed \d+ Android helper node/);
  assert.match(text, /@e2 \[button\] "Send message"/);
  assert.match(text, /@e3 \[button\] "Send"/);
});

test('formatSnapshotText labels Android helper action rows with trailing child controls', () => {
  const nodes = [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'android.widget.FrameLayout',
      rect: { x: 0, y: 0, width: 390, height: 844 },
    },
    {
      ref: 'e2',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'android.view.ViewGroup',
      identifier: 'com.google.android.youtube:id/linearLayout',
      rect: { x: 0, y: 120, width: 390, height: 48 },
      hittable: true,
    },
    {
      ref: 'e3',
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'android.widget.ImageView',
      rect: { x: 4, y: 132, width: 40, height: 24 },
    },
    {
      ref: 'e4',
      index: 3,
      depth: 2,
      parentIndex: 1,
      type: 'android.widget.TextView',
      label: 'lofi hip hop',
      rect: { x: 52, y: 132, width: 260, height: 24 },
    },
    {
      ref: 'e5',
      index: 4,
      depth: 2,
      parentIndex: 1,
      type: 'android.widget.ImageView',
      label: 'Edit suggestion lofi hip hop',
      rect: { x: 330, y: 120, width: 48, height: 48 },
      hittable: true,
    },
  ];

  const text = withNoColor(() =>
    formatSnapshotText({
      nodes,
      truncated: false,
      androidSnapshot: { backend: 'android-helper' },
    }),
  );

  assert.match(text, /Snapshot: 3 visible nodes \(5 total\)/);
  assert.match(text, /@e2 \[group\] "lofi hip hop"/);
  assert.doesNotMatch(text, /@e4 \[text\] "lofi hip hop"/);
  assert.match(text, /@e5 \[image\] "Edit suggestion lofi hip hop"/);
});

test('formatSnapshotText hides Android helper rectless offscreen rows and derives above hints', () => {
  const nodes = [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'android.widget.FrameLayout',
      rect: { x: 0, y: 0, width: 390, height: 844 },
    },
    {
      ref: 'e2',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'android.widget.ScrollView',
      rect: { x: 0, y: 120, width: 390, height: 640 },
      hiddenContentBelow: true,
    },
    {
      ref: 'e3',
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'android.widget.Button',
      label: 'Save Citrus Starter Kit',
      hittable: true,
    },
    {
      ref: 'e4',
      index: 3,
      depth: 2,
      parentIndex: 1,
      type: 'android.widget.Button',
      label: 'View details',
      identifier: 'details-pretzel-bites',
      rect: { x: 24, y: 180, width: 342, height: 48 },
      hittable: true,
    },
    {
      ref: 'e5',
      index: 4,
      depth: 3,
      parentIndex: 3,
      type: 'android.widget.TextView',
      label: 'View details',
      rect: { x: 140, y: 192, width: 110, height: 24 },
    },
  ];

  const text = withNoColor(() =>
    formatSnapshotText({
      nodes,
      truncated: false,
      androidSnapshot: { backend: 'android-helper' },
    }),
  );

  assert.match(text, /Snapshot: 3 visible nodes \(5 total\)/);
  assert.match(text, /\[content above scroll-area hidden\]/);
  assert.match(text, /\[content below scroll-area hidden\]/);
  assert.doesNotMatch(text, /Save Citrus Starter Kit/);
  assert.match(text, /@e4 \[button\] "View details"/);
  assert.doesNotMatch(text, /@e5 \[text\] "View details"/);
});
