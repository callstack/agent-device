import { SCREENSHOT_RESULT } from './fixtures.ts';

export const SNAPSHOT_DIGEST = {
  nodeCount: 4,
  refs: [
    { ref: 'e2', label: 'Email' },
    { ref: 'e3', label: 'Place order' },
  ],
  truncated: false,
  visibility: {
    partial: false,
    visibleNodeCount: 4,
    totalNodeCount: 4,
    reasons: [],
  },
  refsGeneration: 12,
};

export const SETTLE_DIGEST = {
  ref: 'e3',
  x: 195,
  y: 744,
  message: 'Tapped @e3 (195, 744)',
  settle: {
    settled: true,
    waitedMs: 620,
    captures: 3,
    quietMs: 250,
    timeoutMs: 3000,
    refsGeneration: 13,
    refs: [{ ref: 'e4' }, { ref: 'e5' }],
    diff: { summary: { additions: 2, removals: 1, unchanged: 4 } },
  },
};

export const SETTLE_TAIL_DIGEST = {
  ref: 'e6',
  x: 320,
  y: 90,
  message: 'Tapped @e6 (320, 90)',
  settle: {
    settled: true,
    waitedMs: 410,
    captures: 2,
    quietMs: 250,
    timeoutMs: 3000,
    refsGeneration: 14,
    tail: [
      { ref: 'e7', role: 'button', label: 'Continue' },
      { ref: 'e9', role: 'tab', label: 'Home' },
    ],
    diff: { summary: { additions: 0, removals: 2, unchanged: 6 } },
  },
};

export const SELECTOR_DIGEST = {
  ref: '@e2',
  text: 'qa@example.com',
  warning: 'Recovered from a blocking system dialog',
};

export const SCREENSHOT_DEFAULT_VIEW = SCREENSHOT_RESULT;

export const SCREENSHOT_DIGEST = {
  path: '/tmp/agent-device/economy-fixture.png',
  width: 1170,
  height: 2532,
  logicalWidth: 390,
  logicalHeight: 844,
  pixelDensity: 3,
  overlayCount: 2,
  overlayRefs: [
    { ref: 'e2', label: 'Email' },
    { ref: 'e3', label: 'Place order' },
  ],
  artifacts: [
    {
      field: 'path',
      artifactType: 'screenshot',
      artifactId: 'artifact-economy-fixture',
      fileName: 'economy-fixture.png',
    },
  ],
};

export const NETWORK_DIGEST = {
  path: '/tmp/agent-device/economy-fixture/app.log',
  exists: true,
  active: true,
  state: 'active',
  backend: 'ios-simulator',
  include: 'all',
  scannedLines: 4000,
  matchedLines: 8,
  limits: {
    maxEntries: 25,
    maxPayloadChars: 2048,
    maxScanLines: 4000,
  },
  entries: [
    {
      timestamp: '2026-07-02T12:00:00.000Z',
      method: 'POST',
      url: 'https://api.example.test/checkout/1',
      status: 503,
      durationMs: 120,
      packetId: 'packet-1',
      line: 3900,
    },
    {
      timestamp: '2026-07-02T12:00:01.000Z',
      method: 'GET',
      url: 'https://api.example.test/checkout/2',
      status: 200,
      durationMs: 137,
      packetId: 'packet-2',
      line: 3901,
    },
    {
      timestamp: '2026-07-02T12:00:02.000Z',
      method: 'GET',
      url: 'https://api.example.test/checkout/3',
      status: 200,
      durationMs: 154,
      packetId: 'packet-3',
      line: 3902,
    },
    {
      timestamp: '2026-07-02T12:00:03.000Z',
      method: 'GET',
      url: 'https://api.example.test/checkout/4',
      status: 200,
      durationMs: 171,
      packetId: 'packet-4',
      line: 3903,
    },
    {
      timestamp: '2026-07-02T12:00:04.000Z',
      method: 'GET',
      url: 'https://api.example.test/checkout/5',
      status: 200,
      durationMs: 188,
      packetId: 'packet-5',
      line: 3904,
    },
    {
      timestamp: '2026-07-02T12:00:05.000Z',
      method: 'GET',
      url: 'https://api.example.test/checkout/6',
      status: 200,
      durationMs: 205,
      packetId: 'packet-6',
      line: 3905,
    },
    {
      timestamp: '2026-07-02T12:00:06.000Z',
      method: 'GET',
      url: 'https://api.example.test/checkout/7',
      status: 200,
      durationMs: 222,
      packetId: 'packet-7',
      line: 3906,
    },
    {
      timestamp: '2026-07-02T12:00:07.000Z',
      method: 'GET',
      url: 'https://api.example.test/checkout/8',
      status: 200,
      durationMs: 239,
      packetId: 'packet-8',
      line: 3907,
    },
  ],
  notes: ['The first checkout request returned 503. Retry after the service recovery window.'],
};
