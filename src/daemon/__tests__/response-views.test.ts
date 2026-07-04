import { test, expect } from 'vitest';
import { RESPONSE_VIEWS } from '../response-views.ts';
import type { DaemonResponseData } from '../types.ts';

const snapshotView = RESPONSE_VIEWS.snapshot;
const screenshotView = RESPONSE_VIEWS.screenshot;
const findView = RESPONSE_VIEWS.find;
const getView = RESPONSE_VIEWS.get;

const SNAPSHOT_DATA: DaemonResponseData = {
  nodes: [
    { ref: 'e1', hittable: true, label: 'Login' },
    { ref: 'e2', hittable: false, label: 'Heading' }, // not hittable → excluded
    { ref: 'e3', hittable: true, interactionBlocked: 'covered', label: 'Hidden' }, // occluded → excluded
    { ref: 'e4', hittable: true, value: 'from-value' }, // label falls back to value
  ],
  truncated: false,
  visibility: { partial: false, visibleNodeCount: 4, totalNodeCount: 4, reasons: [] },
  snapshotQuality: { state: 'healthy', backend: 'tree' },
  appName: 'Demo', // a non-cheap field that the digest intentionally drops
};

test('snapshot view is registered', () => {
  expect(typeof snapshotView).toBe('function');
});

test('digest collapses the node tree to count + actionable refs + cheap signals', () => {
  const digest = snapshotView!(SNAPSHOT_DATA, 'digest');
  expect(digest).toEqual({
    nodeCount: 4,
    refs: [
      { ref: 'e1', label: 'Login' },
      { ref: 'e4', label: 'from-value' },
    ],
    truncated: false,
    visibility: { partial: false, visibleNodeCount: 4, totalNodeCount: 4, reasons: [] },
    snapshotQuality: { state: 'healthy', backend: 'tree' },
  });
  // The full node tree (the token sink) and non-cheap fields are dropped.
  expect('nodes' in digest).toBe(false);
  expect('appName' in digest).toBe(false);
});

test('default and full return today’s shape unchanged (same reference)', () => {
  expect(snapshotView!(SNAPSHOT_DATA, 'default')).toBe(SNAPSHOT_DATA);
  expect(snapshotView!(SNAPSHOT_DATA, 'full')).toBe(SNAPSHOT_DATA);
});

test('digest tolerates missing/empty node trees', () => {
  const digest = snapshotView!({ truncated: true }, 'digest');
  expect(digest).toMatchObject({ nodeCount: 0, refs: [], truncated: true });
});

const overlayRef = (ref: string, label: string | undefined) => ({
  ref,
  ...(label !== undefined ? { label } : {}),
  rect: { x: 0, y: 0, width: 40, height: 20 },
  overlayRect: { x: 0, y: 0, width: 100, height: 50 },
  center: { x: 50, y: 25 },
});

const SCREENSHOT_DATA: DaemonResponseData = {
  path: '/tmp/agent-device-screenshot-xyz/screenshot.png',
  overlayRefs: [
    overlayRef('e1', 'Continue'),
    overlayRef('e2', undefined), // label omitted → stays undefined in the digest
  ],
  artifacts: [
    {
      field: 'path',
      artifactType: 'screenshot',
      artifactId: 'art-1',
      fileName: 'screenshot.png',
    },
  ], // cheap retrieval handle — preserved
};

test('screenshot view is registered', () => {
  expect(typeof screenshotView).toBe('function');
});

test('digest collapses overlay geometry to count + leveled refs, keeps cheap fields', () => {
  const digest = screenshotView!(SCREENSHOT_DATA, 'digest');
  expect(digest).toEqual({
    path: '/tmp/agent-device-screenshot-xyz/screenshot.png',
    overlayCount: 2,
    overlayRefs: [
      { ref: 'e1', label: 'Continue' },
      { ref: 'e2', label: undefined },
    ],
    artifacts: [
      {
        field: 'path',
        artifactType: 'screenshot',
        artifactId: 'art-1',
        fileName: 'screenshot.png',
      },
    ],
  });
  // The per-overlay geometry (the token sink) is dropped from every ref.
  expect(digest.overlayRefs).not.toContainEqual(
    expect.objectContaining({ rect: expect.anything() }),
  );
});

test('digest caps the overlay list at 12 while counting them all', () => {
  const overlayRefs = Array.from({ length: 20 }, (_, i) => overlayRef(`e${i + 1}`, `L${i + 1}`));
  const digest = screenshotView!({ path: '/tmp/s.png', overlayRefs }, 'digest');
  expect(digest.overlayCount).toBe(20);
  expect(Array.isArray(digest.overlayRefs) && digest.overlayRefs).toHaveLength(12);
});

test('screenshot default and full return today’s shape unchanged (same reference)', () => {
  expect(screenshotView!(SCREENSHOT_DATA, 'default')).toBe(SCREENSHOT_DATA);
  expect(screenshotView!(SCREENSHOT_DATA, 'full')).toBe(SCREENSHOT_DATA);
});

test('screenshot digest tolerates a path-only result with no overlay refs', () => {
  const digest = screenshotView!({ path: '/tmp/s.png' }, 'digest');
  expect(digest).toEqual({ path: '/tmp/s.png', overlayCount: 0, overlayRefs: [] });
});

// A verbose matched node as it appears on the `find`/`get` wire: the semantic
// attributes (kept) plus the geometry/index/process plumbing (the token sink).
const MATCHED_NODE = {
  ref: 'e7',
  role: 'AXButton',
  type: 'Button',
  label: 'Sign in',
  value: 'enabled',
  identifier: 'login-button',
  enabled: true,
  selected: false,
  focused: false,
  hittable: true,
  // verbose framing the digest intentionally drops:
  rect: { x: 10, y: 20, width: 100, height: 44 },
  index: 7,
  parentIndex: 3,
  depth: 4,
  pid: 1234,
  bundleId: 'com.demo.app',
  appName: 'Demo',
  windowTitle: 'Demo',
  surface: 'app',
  visibleToUser: true,
};

const COMPACT_NODE = {
  ref: 'e7',
  role: 'AXButton',
  type: 'Button',
  label: 'Sign in',
  value: 'enabled',
  identifier: 'login-button',
  enabled: true,
  selected: false,
  focused: false,
  hittable: true,
};

test('find and get views are registered (shared selector-read view)', () => {
  expect(typeof findView).toBe('function');
  expect(typeof getView).toBe('function');
  expect(findView).toBe(getView);
});

test('find get-text digest keeps ref + text, drops the verbose node', () => {
  const digest = findView!({ ref: '@e7', text: 'Sign in', node: MATCHED_NODE }, 'digest');
  expect(digest).toEqual({ ref: '@e7', text: 'Sign in' });
  expect('node' in digest).toBe(false);
});

test('a text read keeps every OTHER cheap field (e.g. warning) while dropping the node', () => {
  const digest = findView!(
    {
      ref: '@e7',
      text: 'Sign in',
      warning: 'recovered from a blocking dialog',
      node: MATCHED_NODE,
    },
    'digest',
  );
  expect(digest).toEqual({
    ref: '@e7',
    text: 'Sign in',
    warning: 'recovered from a blocking dialog',
  });
});

test('find get-attrs digest compacts the node to semantic attributes only', () => {
  const digest = findView!({ ref: '@e7', node: MATCHED_NODE }, 'digest');
  expect(digest).toEqual({ ref: '@e7', node: COMPACT_NODE });
  // The geometry/index/process plumbing (the token sink) is dropped from the node.
  expect('rect' in (digest.node as Record<string, unknown>)).toBe(false);
  expect('parentIndex' in (digest.node as Record<string, unknown>)).toBe(false);
});

test('an attrs read compacts the node but keeps every other cheap field (e.g. warning)', () => {
  const digest = getView!({ ref: 'e7', warning: 'partial tree', node: MATCHED_NODE }, 'digest');
  expect(digest).toEqual({ ref: 'e7', warning: 'partial tree', node: COMPACT_NODE });
});

// REGRESSION: `find` is registered command-wide, but `find fill/focus/type` return
// the underlying INTERACTION response (carrying cheap, agent-critical signals like
// `warning`/`message`), which has no verbose snapshot node. The conservative view
// must return such a node-less shape UNCHANGED — never allowlist-narrow it.
test('find fill/focus/type interaction responses pass through UNCHANGED (warning kept)', () => {
  const fillResponse: DaemonResponseData = {
    ref: 'e3',
    text: 'hello',
    message: 'Filled 5 chars',
    warning: 'Recovered from a blocking system dialog',
  };
  const digest = findView!(fillResponse, 'digest');
  expect(digest).toBe(fillResponse); // same reference — not narrowed at all
  expect(digest).toEqual(fillResponse);
});

test('find exists/wait/click digests pass through the cheap actionable signals', () => {
  // No verbose node → returned UNCHANGED (same reference).
  const exists: DaemonResponseData = { found: true };
  const wait: DaemonResponseData = { found: true, waitedMs: 320 };
  const click: DaemonResponseData = { ref: '@e7', locator: 'text', query: 'Sign in', x: 60, y: 42 };
  expect(findView!(exists, 'digest')).toBe(exists);
  expect(findView!(wait, 'digest')).toBe(wait);
  expect(findView!(click, 'digest')).toBe(click);
});

test('get text digest keeps selector + text and drops the node', () => {
  const digest = getView!(
    { selector: 'text=Sign in', text: 'Sign in', node: MATCHED_NODE },
    'digest',
  );
  expect(digest).toEqual({ selector: 'text=Sign in', text: 'Sign in' });
});

test('get attrs digest compacts the node under a ref target', () => {
  const digest = getView!({ ref: 'e7', node: MATCHED_NODE }, 'digest');
  expect(digest).toEqual({ ref: 'e7', node: COMPACT_NODE });
});

test('find/get default and full return today’s shape unchanged (same reference)', () => {
  const data: DaemonResponseData = { ref: '@e7', text: 'Sign in', node: MATCHED_NODE };
  expect(findView!(data, 'default')).toBe(data);
  expect(findView!(data, 'full')).toBe(data);
  expect(getView!(data, 'default')).toBe(data);
  expect(getView!(data, 'full')).toBe(data);
});

test('snapshot digest preserves refsGeneration — the pinning signal for the refs it keeps (#1076)', () => {
  const digest = RESPONSE_VIEWS.snapshot!({ ...SNAPSHOT_DATA, refsGeneration: 7 }, 'digest');
  expect(digest.refsGeneration).toBe(7);
});
