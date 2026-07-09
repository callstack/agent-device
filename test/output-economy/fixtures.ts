import type { CaptureSnapshotResult, CommandRequestResult } from '../../src/client/client-types.ts';
import type { DaemonResponseData } from '../../src/daemon/types.ts';
import { AppError } from '../../src/kernel/errors.ts';
import { attachRefs, type RawSnapshotNode } from '../../src/kernel/snapshot.ts';

const SNAPSHOT_NODES: RawSnapshotNode[] = [
  {
    index: 0,
    type: 'Window',
    label: 'Checkout',
    depth: 0,
    rect: { x: 0, y: 0, width: 390, height: 844 },
  },
  {
    index: 1,
    type: 'TextField',
    role: 'text-field',
    label: 'Email',
    value: 'qa@example.com',
    identifier: 'checkout-email',
    hittable: true,
    enabled: true,
    depth: 1,
    parentIndex: 0,
    rect: { x: 20, y: 120, width: 350, height: 44 },
  },
  {
    index: 2,
    type: 'Button',
    role: 'button',
    label: 'Place order',
    identifier: 'submit-order',
    hittable: true,
    enabled: true,
    depth: 1,
    parentIndex: 0,
    rect: { x: 20, y: 720, width: 350, height: 48 },
  },
  {
    index: 3,
    type: 'StaticText',
    role: 'text',
    label: 'Terms and conditions apply',
    hittable: false,
    depth: 1,
    parentIndex: 0,
    rect: { x: 20, y: 790, width: 350, height: 24 },
  },
];

export const SNAPSHOT_RESULT: CaptureSnapshotResult = {
  nodes: attachRefs(SNAPSHOT_NODES),
  truncated: false,
  identifiers: { session: 'economy-fixture' },
  visibility: {
    partial: false,
    visibleNodeCount: 4,
    totalNodeCount: 4,
    reasons: [],
  },
};

export const SNAPSHOT_DAEMON_RESULT: DaemonResponseData = {
  ...SNAPSHOT_RESULT,
  refsGeneration: 12,
};

export const SETTLE_ADDED_REF_RESULT: CommandRequestResult = {
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
    diff: {
      summary: { additions: 2, removals: 1, unchanged: 4 },
      lines: [
        { kind: 'removed', text: '@e3 [button] "Place order"' },
        { kind: 'added', text: '@e4 [text] "Order confirmed"', ref: 'e4' },
        { kind: 'added', text: '@e5 [button] "View receipt"', ref: 'e5' },
      ],
    },
  },
};

export const SETTLE_TAIL_RESULT: CommandRequestResult = {
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
    diff: {
      summary: { additions: 0, removals: 2, unchanged: 6 },
      lines: [
        { kind: 'removed', text: '@e6 [button] "Dismiss"' },
        { kind: 'removed', text: '@e8 [text] "Saved"' },
      ],
    },
    tail: [
      { ref: 'e7', role: 'button', label: 'Continue' },
      { ref: 'e9', role: 'tab', label: 'Home' },
    ],
  },
};

export const NOT_SETTLED_RESULT: CommandRequestResult = {
  ref: 'e3',
  message: 'Tapped @e3 (195, 744)',
  settle: {
    settled: false,
    waitedMs: 3000,
    hint: 'The UI kept changing. Run wait stable or take a fresh snapshot -i.',
  },
};

export const SELECTOR_READ_RESULT: DaemonResponseData = {
  ref: '@e2',
  text: 'qa@example.com',
  warning: 'Recovered from a blocking system dialog',
  node: {
    ...SNAPSHOT_RESULT.nodes[1],
    pid: 417,
    bundleId: 'com.example.checkout',
    appName: 'Checkout',
    windowTitle: 'Checkout',
    surface: 'app',
  },
};

const overlayRef = (ref: string, label: string) => ({
  ref,
  label,
  rect: { x: 20, y: 120, width: 350, height: 44 },
  overlayRect: { x: 18, y: 118, width: 354, height: 48 },
  center: { x: 195, y: 142 },
});

export const SCREENSHOT_RESULT: DaemonResponseData = {
  path: '/tmp/agent-device/economy-fixture.png',
  width: 1170,
  height: 2532,
  logicalWidth: 390,
  logicalHeight: 844,
  pixelDensity: 3,
  overlayRefs: [overlayRef('e2', 'Email'), overlayRef('e3', 'Place order')],
  artifacts: [
    {
      field: 'path',
      artifactType: 'screenshot',
      artifactId: 'artifact-economy-fixture',
      fileName: 'economy-fixture.png',
    },
  ],
};

export const ACTIONABLE_ERROR = new AppError(
  'DEVICE_IN_USE',
  'Device ios-simulator-1 is already used by session checkout',
  {
    hint: 'Run agent-device close --session checkout, then retry.',
    retriable: true,
    reason: 'session-lock',
  },
);

export const POLICY_NORMALIZED_ERROR = new AppError(
  'DEVICE_IN_USE',
  'Device android-emulator-2 is already used by session smoke',
  { reason: 'session-lock' },
);
