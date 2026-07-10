import { test } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import {
  formatScreenshotDiffText,
  formatSnapshotDiffText,
  formatSnapshotText,
  printHumanError,
} from '../output.ts';
import { formatRole, formatSnapshotLine } from '../../snapshot/snapshot-lines.ts';
import { normalizedRect } from '../screenshot-geometry.ts';
import { AppError } from '../../kernel/errors.ts';

function captureStderr(run: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let output = '';
  (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((
    chunk: unknown,
  ) => {
    output += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return output;
}

const DIFF_DATA = {
  mode: 'snapshot',
  baselineInitialized: false,
  summary: { additions: 1, removals: 1, unchanged: 1 },
  lines: [
    { kind: 'unchanged', text: '@e2 [window]' },
    { kind: 'removed', text: '  @e3 [text] "67"' },
    { kind: 'added', text: '  @e3 [text] "134"' },
  ],
} as const;

test('formatRole falls back for object prototype role names', () => {
  assert.equal(formatRole('constructor'), 'constructor');
  assert.equal(formatRole('__proto__'), '__proto__');
  assert.equal(formatRole('com.android.constructor'), 'constructor');
});

test('formatSnapshotDiffText renders plain text when color is disabled', () => {
  const originalForceColor = process.env.FORCE_COLOR;
  const originalNoColor = process.env.NO_COLOR;
  process.env.FORCE_COLOR = '0';
  delete process.env.NO_COLOR;
  try {
    const text = formatSnapshotDiffText({ ...DIFF_DATA });
    assert.match(text, /^@e2 \[window\]/m);
    assert.match(text, /^-  @e3 \[text\] "67"$/m);
    assert.match(text, /^\+  @e3 \[text\] "134"$/m);
    assert.match(text, /1 additions, 1 removals, 1 unchanged/);
    assert.equal(text.includes('\x1b['), false);
  } finally {
    if (typeof originalForceColor === 'string') process.env.FORCE_COLOR = originalForceColor;
    else delete process.env.FORCE_COLOR;
    if (typeof originalNoColor === 'string') process.env.NO_COLOR = originalNoColor;
    else delete process.env.NO_COLOR;
  }
});

test('formatSnapshotDiffText renders ANSI colors when forced', () => {
  const originalForceColor = process.env.FORCE_COLOR;
  const originalNoColor = process.env.NO_COLOR;
  process.env.FORCE_COLOR = '1';
  delete process.env.NO_COLOR;
  try {
    const text = formatSnapshotDiffText({ ...DIFF_DATA });
    const plainText = stripVTControlCharacters(text);
    assert.notEqual(text, plainText);
    assert.match(plainText, /^@e2 \[window\]/m);
    assert.match(plainText, /^-  @e3 \[text\] "67"$/m);
    assert.match(plainText, /^\+  @e3 \[text\] "134"$/m);
    assert.match(plainText, /1 additions, 1 removals, 1 unchanged/);
  } finally {
    if (typeof originalForceColor === 'string') process.env.FORCE_COLOR = originalForceColor;
    else delete process.env.FORCE_COLOR;
    if (typeof originalNoColor === 'string') process.env.NO_COLOR = originalNoColor;
    else delete process.env.NO_COLOR;
  }
});

test('formatSnapshotDiffText prints warnings before the diff body', () => {
  const text = withNoColor(() =>
    formatSnapshotDiffText({
      ...DIFF_DATA,
      warnings: ['Recent press was followed by a nearly identical snapshot.'],
    }),
  );
  assert.match(text, /^Recent press was followed by a nearly identical snapshot\.$/m);
  assert.match(text, /^@e2 \[window\]$/m);
  assert.match(text, /1 additions, 1 removals, 1 unchanged/);
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
  assert.match(text, /  @e17 \[group\] "HomePage"/);
  assert.match(text, /    @e21 \[group\] "Home"/);
  assert.match(text, /    @e22 \[button\] "Search"/);
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
  assert.match(text, /^  @e3 \[button\] "Back"$/m);
  assert.match(text, /^    @e5 \[image\]$/m);
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
  assert.match(text, /^  @e2 \[button\] "Settings"$/m);
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

  assert.match(text, /^  @e3 \[button\] "View"$/m);
  assert.doesNotMatch(text, /\[off-screen above\].*"View"/);
  assert.match(text, /\[off-screen below\] 1 interactive item: "Later"/);
});

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
  assert.match(text, /^  @e2 \[scroll-area\] "Messages" \[scrollable\]$/m);
  assert.match(text, /^    \[content above scroll-area hidden\]$/m);
  assert.match(text, /^    \[content below scroll-area hidden\]$/m);
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

  assert.match(text, /^  @e2 \[scroll-area\] "Catalog" \[scrollable\]$/m);
  assert.match(text, /^  @e3 \[button\] "Visible product"$/m);
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
  assert.match(text, /^  \[content above scroll-area hidden\]$/m);
  assert.match(text, /^  \[content below scroll-area hidden\]$/m);
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
  assert.match(text, /^  \[content below list hidden\]$/m);
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
  assert.match(text, /^  @e3 \[text\] "Text view"$/m);
  assert.match(text, /^    @e4 \[text\] "loadJSBundleFromAssets"$/m);
  assert.match(text, /^  \[content below list hidden\]$/m);
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

  assert.match(text, /^  @e2 \[scroll-area\] "Messages" \[scrollable\]$/m);
  assert.match(text, /^    \[content above scroll-area hidden\]$/m);
  assert.match(text, /^    \[content below scroll-area hidden\]$/m);
  assert.match(text, /^    @e4 \[button\] "Visible message"$/m);
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

  assert.match(text, /^  @e2 \[scroll-area\] \[scrollable\]$/m);
  assert.match(text, /^    \[content below scroll-area hidden\]$/m);
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

function withNoColor<T>(fn: () => T): T {
  const originalForceColor = process.env.FORCE_COLOR;
  const originalNoColor = process.env.NO_COLOR;
  process.env.FORCE_COLOR = '0';
  delete process.env.NO_COLOR;
  try {
    return fn();
  } finally {
    if (typeof originalForceColor === 'string') process.env.FORCE_COLOR = originalForceColor;
    else delete process.env.FORCE_COLOR;
    if (typeof originalNoColor === 'string') process.env.NO_COLOR = originalNoColor;
    else delete process.env.NO_COLOR;
  }
}

function withColor<T>(fn: () => T): T {
  const originalForceColor = process.env.FORCE_COLOR;
  const originalNoColor = process.env.NO_COLOR;
  process.env.FORCE_COLOR = '1';
  delete process.env.NO_COLOR;
  try {
    return fn();
  } finally {
    if (typeof originalForceColor === 'string') process.env.FORCE_COLOR = originalForceColor;
    else delete process.env.FORCE_COLOR;
    if (typeof originalNoColor === 'string') process.env.NO_COLOR = originalNoColor;
    else delete process.env.NO_COLOR;
  }
}

test('formatScreenshotDiffText renders match success without color', () => {
  const text = withNoColor(() =>
    formatScreenshotDiffText({
      match: true,
      differentPixels: 0,
      totalPixels: 100,
      mismatchPercentage: 0,
    }),
  );
  assert.match(text, /✓ Screenshots match\./);
  assert.equal(text.includes('\x1b['), false);
});

test('formatScreenshotDiffText renders mismatch with pixel counts without color', () => {
  const text = withNoColor(() =>
    formatScreenshotDiffText({
      match: false,
      differentPixels: 500,
      totalPixels: 10000,
      mismatchPercentage: 5,
      diffPath: '/tmp/test/diff.png',
      currentOverlayPath: '/tmp/test/diff.current-overlay.png',
      currentOverlayRefCount: 1,
      regions: [
        {
          index: 1,
          rect: { x: 10, y: 20, width: 100, height: 40 },
          normalizedRect: normalizedRect({ x: 10, y: 20, width: 100, height: 40 }),
          differentPixels: 350,
          shareOfDiffPercentage: 70,
          densityPercentage: 8.75,
          shape: 'horizontal-band',
          size: 'medium',
          location: 'top-left',
          averageBaselineColorHex: '#141414',
          averageCurrentColorHex: '#dcdcdc',
          baselineLuminance: 20,
          currentLuminance: 220,
          dominantChange: 'brighter',
          currentOverlayMatches: [
            {
              ref: 'e1',
              label: 'Continue',
              rect: { x: 1, y: 2, width: 3, height: 4 },
              regionCoveragePercentage: 12,
            },
          ],
        },
      ],
      ocr: {
        provider: 'tesseract',
        baselineBlocks: 2,
        currentBlocks: 2,
        matches: [
          {
            text: 'Wi-Fi',
            baselineRect: { x: 120, y: 320, width: 60, height: 22 },
            currentRect: { x: 130, y: 332, width: 70, height: 22 },
            delta: { x: 10, y: 12, width: 10, height: 0 },
            confidence: 94,
            possibleTextMetricMismatch: true,
          },
        ],
        movementClusters: [
          {
            texts: ['Wi-Fi', 'Bluetooth'],
            xRange: { min: 10, max: 12 },
            yRange: { min: 10, max: 14 },
          },
        ],
      },
      nonTextDeltas: [
        {
          index: 1,
          regionIndex: 1,
          slot: 'leading',
          likelyKind: 'icon',
          rect: { x: 80, y: 318, width: 30, height: 30 },
          nearestText: 'Wi-Fi',
        },
        {
          index: 2,
          regionIndex: 1,
          slot: 'separator',
          likelyKind: 'separator',
          rect: { x: 90, y: 360, width: 120, height: 2 },
        },
      ],
    }),
  );
  assert.match(text, /✗ 5% pixels differ/);
  assert.match(text, /Diff image:/);
  assert.match(text, /Current overlay:/);
  assert.match(text, /diff\.current-overlay\.png \(1 refs\)/);
  assert.match(text, /500 different \/ 10000 total pixels/);
  assert.match(text, /Hints:/);
  assert.match(
    text,
    /text movement cluster: "Wi-Fi", "Bluetooth" dx=\+10\.\.\+12px dy=\+10\.\.\+14px/,
  );
  assert.match(text, /non-text controls: icon near "Wi-Fi" r1/);
  assert.match(text, /non-text boundaries: separator r1/);
  assert.match(text, /Changed regions:/);
  assert.match(text, /1\. top-left x=10 y=20 100x40, 70% of diff, change=brighter/);
  assert.match(
    text,
    /size=medium shape=horizontal-band density=8\.75% avgColor=#141414->#dcdcdc luminance=20->220/,
  );
  assert.match(text, /overlaps @e1 "Continue", 12% of region/);
  assert.match(
    text,
    /OCR text deltas \(tesseract; baselineBlocks=2 currentBlocks=2; showing 1\/1; px\):/,
  );
  assert.match(
    text,
    /item \| text \| movePx \| sizeDeltaPx \| bboxBaseline \| bboxCurrent \| confidence \| issueHint/,
  );
  assert.match(
    text,
    /1 \| "Wi-Fi" \| \+10,\+12 \| \+10,0 \| x=120,y=320,w=60,h=22 \| x=130,y=332,w=70,h=22 \| 94 \| ocr-bbox-size-change/,
  );
  assert.match(text, /Non-text visual deltas \(showing 2\/2; px\):/);
  assert.match(text, /item \| region \| slot \| kind \| bboxCurrent \| nearestText/);
  assert.match(text, /1 \| r1 \| leading \| icon \| x=80,y=318,w=30,h=30 \| "Wi-Fi"/);
  assert.match(text, /2 \| r1 \| separator \| separator \| x=90,y=360,w=120,h=2 \| -/);
  assert.equal(text.includes('\x1b['), false);
});

test('formatScreenshotDiffText renders dimension mismatch', () => {
  const text = withNoColor(() =>
    formatScreenshotDiffText({
      match: false,
      differentPixels: 100,
      totalPixels: 100,
      mismatchPercentage: 100,
      dimensionMismatch: {
        expected: { width: 1170, height: 2532 },
        actual: { width: 1080, height: 1920 },
      },
    }),
  );
  assert.match(text, /✗ Screenshots have different dimensions/);
  assert.match(text, /expected 1170x2532/);
  assert.match(text, /got 1080x1920/);
  assert.equal(text.includes('different /'), false);
});

test('formatScreenshotDiffText renders diff path relative to cwd', () => {
  const cwd = process.cwd();
  const text = withNoColor(() =>
    formatScreenshotDiffText({
      match: false,
      differentPixels: 10,
      totalPixels: 100,
      mismatchPercentage: 10,
      diffPath: `${cwd}/diff.png`,
    }),
  );
  assert.match(text, /\.\/diff\.png/);
  assert.equal(text.includes(cwd), false);
});

test('formatScreenshotDiffText keeps absolute diff path outside cwd', () => {
  const cwd = process.cwd();
  const parentDir = path.dirname(cwd);
  const siblingDir = path.join(parentDir, `${path.basename(cwd)}-sibling`);
  const diffPath = path.join(siblingDir, 'diff.png');
  const text = withNoColor(() =>
    formatScreenshotDiffText({
      match: false,
      differentPixels: 10,
      totalPixels: 100,
      mismatchPercentage: 10,
      diffPath,
    }),
  );
  assert.match(text, new RegExp(diffPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(text.includes('./'), false);
});

test('formatScreenshotDiffText uses ANSI colors when enabled', () => {
  const text = withColor(() =>
    formatScreenshotDiffText({
      match: false,
      differentPixels: 10,
      totalPixels: 100,
      mismatchPercentage: 10,
      diffPath: '/tmp/diff.png',
    }),
  );
  assert.equal(text.includes('\x1b[31m'), true);
  assert.equal(text.includes('\x1b[32m'), true);
  assert.equal(text.includes('\x1b[2m'), true);
});

test('formatScreenshotDiffText does not show diff path when images match', () => {
  const text = withNoColor(() =>
    formatScreenshotDiffText({
      match: true,
      differentPixels: 0,
      totalPixels: 100,
      mismatchPercentage: 0,
      diffPath: '/tmp/diff.png',
    }),
  );
  assert.equal(text.includes('Diff image'), false);
  assert.equal(text.includes('diff.png'), false);
});

// --- ADR 0012 migration step 2: replay divergence compact text report ---

test('printHumanError renders a compact divergence report unconditionally (not gated behind --debug)', () => {
  const err = new AppError(
    'REPLAY_DIVERGENCE',
    'Replay failed at step 2 (click "Save"): not hittable',
    {
      divergence: {
        version: 1,
        kind: 'action-failure',
        step: { index: 2, source: { path: '/tmp/flow.ad', line: 5 } },
        action: 'click "Save"',
        cause: { code: 'COMMAND_FAILED', message: 'not hittable' },
        screen: {
          state: 'available',
          refsGeneration: 3,
          refs: [{ ref: 'e5', role: 'button', label: 'Save' }],
        },
        suggestions: [
          { selector: 'id="save"', basis: 'id', ref: 'e5', role: 'button', label: 'Save' },
        ],
        suggestionCount: 1,
        resume: { allowed: false, reason: 'resume not yet supported' },
      },
    },
  );

  const output = captureStderr(() => printHumanError(err));

  assert.match(output, /Divergence at step 2 \(\/tmp\/flow\.ad:5\)/);
  assert.match(output, /Screen: 1 actionable ref\(s\) captured \(refsGeneration 3\)/);
  assert.match(output, /@e5 \[button\] "Save"/);
  assert.match(output, /Suggestions:/);
  assert.match(output, /\[id\] "Save" id="save"/);
  // Not gated behind --debug: showDetails defaults to false/undefined here.
});

test('printHumanError shows an unavailable screen reason and omitted suggestions hint', () => {
  const err = new AppError('REPLAY_DIVERGENCE', 'Replay failed at step 1', {
    divergence: {
      version: 1,
      kind: 'action-failure',
      step: { index: 1, source: { path: '/tmp/flow.ad', line: 1 } },
      action: 'click "Save"',
      cause: { code: 'COMMAND_FAILED', message: 'not hittable' },
      screen: {
        state: 'unavailable',
        reason: 'capture-failed',
        hint: 'take a snapshot to observe the result.',
      },
      suggestions: [],
      suggestionCount: 2,
      resume: { allowed: false, reason: 'resume not yet supported' },
    },
  });

  const output = captureStderr(() => printHumanError(err));

  assert.match(output, /Screen: unavailable \(capture-failed\)\. take a snapshot/);
  assert.match(output, /Suggestions: 2 available \(omitted at this response level/);
});
