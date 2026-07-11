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
  width: 402,
  height: 874,
  logicalWidth: 402,
  logicalHeight: 874,
  pixelDensity: 1,
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
    width: 402,
    height: 874,
    logicalWidth: 402,
    logicalHeight: 874,
    pixelDensity: 1,
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

// --- #1101 --settle: interaction settle digest view ---

const SETTLE_DATA: DaemonResponseData = {
  ref: 'e2',
  x: 200,
  y: 322,
  message: 'Tapped @e2 (200, 322)',
  settle: {
    settled: true,
    waitedMs: 60,
    captures: 2,
    quietMs: 25,
    timeoutMs: 2000,
    refsGeneration: 8,
    diff: {
      summary: { additions: 1, removals: 1, unchanged: 4 },
      lines: [
        { kind: 'removed', text: '@e2 [button] "Continue"' },
        { kind: 'added', text: '@e4 [text] "Welcome!"', ref: 'e4' },
      ],
    },
  },
};

test('interaction settle views are registered for all four touch commands', () => {
  expect(typeof RESPONSE_VIEWS.press).toBe('function');
  expect(RESPONSE_VIEWS.press).toBe(RESPONSE_VIEWS.click);
  expect(RESPONSE_VIEWS.press).toBe(RESPONSE_VIEWS.fill);
  expect(RESPONSE_VIEWS.press).toBe(RESPONSE_VIEWS.longpress);
});

test('settle digest keeps the verdict, summary, refsGeneration, and capped added refs; drops the line texts', () => {
  const digest = RESPONSE_VIEWS.press!(SETTLE_DATA, 'digest');
  expect(digest.settle).toEqual({
    settled: true,
    waitedMs: 60,
    captures: 2,
    quietMs: 25,
    timeoutMs: 2000,
    refsGeneration: 8,
    refs: [{ ref: 'e4' }],
    diff: { summary: { additions: 1, removals: 1, unchanged: 4 } },
  });
  // Every other (cheap) field is preserved verbatim.
  expect(digest.ref).toBe('e2');
  expect(digest.message).toBe('Tapped @e2 (200, 322)');
});

test('settle digest caps added refs at the snapshot digest ref limit', () => {
  const lines = Array.from({ length: 20 }, (_, index) => ({
    kind: 'added' as const,
    text: `@e${index + 1} [button] "Item ${index + 1}"`,
    ref: `e${index + 1}`,
  }));
  const digest = RESPONSE_VIEWS.press!(
    {
      settle: {
        settled: true,
        waitedMs: 2000,
        captures: 7,
        quietMs: 25,
        timeoutMs: 2000,
        refsGeneration: 9,
        diff: {
          summary: { additions: 20, removals: 0, unchanged: 0 },
          lines,
          truncated: true,
        },
      },
    },
    'digest',
  );

  expect((digest.settle as { refs?: unknown[] }).refs).toHaveLength(12);
  expect((digest.settle as { refs?: unknown[] }).refs?.at(0)).toEqual({ ref: 'e1' });
  expect((digest.settle as { refs?: unknown[] }).refs?.at(11)).toEqual({ ref: 'e12' });
});

test('plain interaction responses pass through UNCHANGED at every level', () => {
  const plain: DaemonResponseData = { ref: 'e2', x: 200, y: 322, message: 'Tapped @e2' };
  expect(RESPONSE_VIEWS.press!(plain, 'digest')).toBe(plain);
  expect(RESPONSE_VIEWS.press!(plain, 'default')).toBe(plain);
  expect(RESPONSE_VIEWS.press!(plain, 'full')).toBe(plain);
  // A diff-less settle payload (stalled/unstored observation) is already cheap.
  const noDiff: DaemonResponseData = { ref: 'e2', settle: { settled: false, hint: 'stalled' } };
  expect(RESPONSE_VIEWS.press!(noDiff, 'digest')).toBe(noDiff);
});

test('settle default and full return today’s shape unchanged (same reference)', () => {
  expect(RESPONSE_VIEWS.press!(SETTLE_DATA, 'default')).toBe(SETTLE_DATA);
  expect(RESPONSE_VIEWS.press!(SETTLE_DATA, 'full')).toBe(SETTLE_DATA);
});

// --- ADR 0012 decision 2: resolution digest view ---

test('resolution digest drops default-level alternatives but keeps schema-required disambiguation fields', () => {
  const data: DaemonResponseData = {
    ref: 'e2',
    resolution: {
      source: 'runtime',
      phase: 'pre-action',
      kind: 'disambiguated',
      matchCount: 3,
      winnerDiagnostic: { diagnosticRef: 'diag-e2', role: 'button', label: 'Profile' },
      tiebreak: 'visible',
      alternatives: [{ diagnosticRef: 'diag-e3' }, { diagnosticRef: 'diag-e4' }],
    },
  };
  const digest = RESPONSE_VIEWS.press!(data, 'digest');
  expect(digest.resolution).toEqual({
    source: 'runtime',
    phase: 'pre-action',
    kind: 'disambiguated',
    matchCount: 3,
    winnerDiagnostic: { diagnosticRef: 'diag-e2', role: 'button', label: 'Profile' },
    tiebreak: 'visible',
  });
});

test('resolution digest leaves unique/ref/not-observed shapes unchanged (no alternatives to drop)', () => {
  const unique: DaemonResponseData = {
    resolution: { source: 'runtime', phase: 'pre-action', kind: 'unique' },
  };
  expect(RESPONSE_VIEWS.press!(unique, 'digest')).toBe(unique);

  const exact: DaemonResponseData = {
    resolution: { source: 'ref', phase: 'pre-action', kind: 'exact' },
  };
  expect(RESPONSE_VIEWS.press!(exact, 'digest')).toBe(exact);

  const labelFallback: DaemonResponseData = {
    resolution: { source: 'ref', phase: 'pre-action', kind: 'label-fallback' },
  };
  expect(RESPONSE_VIEWS.press!(labelFallback, 'digest')).toBe(labelFallback);

  const notObserved: DaemonResponseData = {
    resolution: { source: 'direct-ios', kind: 'not-observed' },
  };
  expect(RESPONSE_VIEWS.press!(notObserved, 'digest')).toBe(notObserved);
});

test('resolution digest and settle digest compose independently', () => {
  const data: DaemonResponseData = {
    ref: 'e2',
    resolution: {
      source: 'runtime',
      phase: 'pre-action',
      kind: 'disambiguated',
      matchCount: 2,
      winnerDiagnostic: { diagnosticRef: 'diag-e2' },
      tiebreak: 'deepest',
      alternatives: [{ diagnosticRef: 'diag-e3' }],
    },
    settle: SETTLE_DATA.settle,
  };
  const digest = RESPONSE_VIEWS.press!(data, 'digest');
  expect((digest.resolution as { alternatives?: unknown[] }).alternatives).toBeUndefined();
  expect((digest.settle as { diff?: { lines?: unknown[] } }).diff?.lines).toBeUndefined();
});

const networkView = RESPONSE_VIEWS.network;

const NETWORK_DATA: DaemonResponseData = {
  path: '/tmp/app.log',
  exists: true,
  active: true,
  state: 'active',
  backend: 'ios-simulator',
  include: 'all',
  scannedLines: 4000,
  matchedLines: 2,
  limits: { maxEntries: 25, maxPayloadChars: 2048, maxScanLines: 4000 },
  entries: [
    {
      method: 'POST',
      url: 'https://api.example.test/checkout/1',
      status: 503,
      timestamp: '2026-07-02T12:00:00.000Z',
      durationMs: 120,
      packetId: 'packet-1',
      line: 3900,
      metadata: { requestId: 'request-1' },
      headers: 'authorization: <redacted>\ncontent-type: application/json',
      requestHeaders: { authorization: '<redacted>' },
      responseHeaders: { 'x-retry-after-ms': '500' },
      requestBody: '{"cartId":"cart-1"}',
      responseBody: '{"error":"service unavailable"}',
      raw: 'network capture 1: {"error":"service unavailable"}',
    },
    {
      method: 'GET',
      url: 'https://api.example.test/checkout/2',
      status: 200,
      timestamp: '2026-07-02T12:00:01.000Z',
      durationMs: 137,
      packetId: 'packet-2',
      line: 3901,
      headers: 'content-type: application/json',
      requestBody: '',
      responseBody: 'ok',
      raw: 'network capture 2: ok',
    },
  ],
  notes: ['The first checkout request returned 503. Retry after the service recovery window.'],
  warnings: ['Network capture omitted one malformed log line.'],
  artifacts: [{ field: 'path', artifactType: 'app-log', artifactId: 'artifact-network-log' }],
};

test('network view is registered', () => {
  expect(typeof networkView).toBe('function');
});

test('network digest keeps the whole dump + every entry identity, dropping only payload material', () => {
  const digest = networkView!(NETWORK_DATA, 'digest');
  // Top-level dump is preserved verbatim.
  for (const key of [
    'path',
    'exists',
    'active',
    'state',
    'backend',
    'include',
    'scannedLines',
    'matchedLines',
    'limits',
    'notes',
    'warnings',
    'artifacts',
  ] as const) {
    expect(digest[key]).toEqual(NETWORK_DATA[key]);
  }
  const entries = digest.entries as Record<string, unknown>[];
  // No entry is dropped or reordered.
  expect(entries).toHaveLength(2);
  // The failed request stays fully diagnosable.
  expect(entries[0]).toEqual({
    method: 'POST',
    url: 'https://api.example.test/checkout/1',
    status: 503,
    timestamp: '2026-07-02T12:00:00.000Z',
    durationMs: 120,
    packetId: 'packet-1',
    line: 3900,
    metadata: { requestId: 'request-1' },
  });
  // Verbose payload material is gone from every entry.
  for (const entry of entries) {
    for (const dropped of [
      'headers',
      'requestHeaders',
      'responseHeaders',
      'requestBody',
      'responseBody',
      'raw',
    ]) {
      expect(dropped in entry).toBe(false);
    }
  }
});

test('network default and full return today’s shape unchanged (same reference)', () => {
  expect(networkView!(NETWORK_DATA, 'default')).toBe(NETWORK_DATA);
  expect(networkView!(NETWORK_DATA, 'full')).toBe(NETWORK_DATA);
});

test('network digest tolerates a missing/empty entries list', () => {
  const empty: DaemonResponseData = { path: '/tmp/app.log', exists: false };
  expect(networkView!(empty, 'digest')).toBe(empty);
  const emptyList: DaemonResponseData = { path: '/tmp/app.log', entries: [] };
  expect(networkView!(emptyList, 'digest')).toEqual({ path: '/tmp/app.log', entries: [] });
});
