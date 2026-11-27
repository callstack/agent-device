import { beforeEach, expect, test, vi } from 'vitest';
import path from 'node:path';
import { handleReactNativeCommands } from '../react-native.ts';
import { captureSnapshot } from '../../../core/snapshot-capture.ts';
import { SessionStore } from '../../../core/session-store.ts';
import type { SessionState } from '../../../core/session-state.ts';
import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { snapshotViewportSizeFrom } from '@agent-device/kernel/rect';
import {
  getRuntimeBindings,
  mockTapPoint,
  resetGetRuntimeFixture,
} from '../../__tests__/interaction-get-runtime-fixture.ts';
import { refFrameState } from '../../../core/ref-frame.ts';
import { fakeCreateCommandSurface } from '../../../__tests__/support/command-surface-fake.ts';

vi.mock('../../../core/snapshot-capture.ts', () => ({
  captureSnapshot: vi.fn(),
}));

const mockCaptureSnapshot = vi.mocked(captureSnapshot);
/**
 * R58: overlay dismissal taps through the same bound `tapPoint` every other touch leaf uses, so
 * this suite watches the bound operation rather than a dispatcher. The recorded point is the
 * whole assertion — the coordinate the overlay heuristic picked.
 */
const mockDismissTap = mockTapPoint;

/** RCTRedBoxController's footer: one button per label in a fill-equally stack across the window. */
function redBoxFooter(labels: string[], y: number, windowWidth: number) {
  const width = windowWidth / labels.length;
  return labels.map((label, column) => ({
    index: column + 1,
    ref: `e${column + 2}`,
    type: 'XCUIElementTypeButton',
    label,
    rect: { x: column * width, y, width, height: 44 },
  }));
}

beforeEach(() => {
  mockCaptureSnapshot.mockReset();
  resetGetRuntimeFixture();
});

test('react-native dismiss-overlay taps collapsed warning close affordance instead of banner center', async () => {
  const sessionName = 'rn-session';
  const sessionStore = makeSessionStore();
  sessionStore.publish(sessionName, makeSession(sessionName));
  mockCaptureSnapshot
    .mockResolvedValueOnce({
      snapshot: {
        nodes: [
          {
            index: 0,
            ref: 'e90',
            label: '!, Open debugger to view warnings.',
            rect: { x: 0, y: 794, width: 402, height: 52 },
            hittable: true,
          },
        ],
        createdAt: Date.now(),
      },
    })
    .mockResolvedValueOnce({
      snapshot: {
        nodes: [
          {
            index: 0,
            ref: 'e1',
            label: 'Submit order',
            rect: { x: 24, y: 600, width: 180, height: 52 },
          },
        ],
        createdAt: Date.now(),
      },
    });

  const response = await handleReactNativeCommands({
    createCommandSurface: fakeCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'react-native',
      positionals: ['dismiss-overlay'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
    contextFromFlags: () => ({}),
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  // ADR 0014 side-effect seam: overlay dismissal taps the device, so it expires
  // the ref frame.
  expect(refFrameState(sessionStore.get(sessionName)!)).toBe('expired');
  expect(mockDismissTap).toHaveBeenCalledWith(
    expect.objectContaining({ point: { x: 379, y: 820 } }),
  );
  expect(response?.ok && response.data).toMatchObject({
    action: 'dismiss-overlay',
    overlayAction: 'close-collapsed-banner',
    verified: true,
    verificationRequired: false,
    x: 379,
    y: 820,
  });
});

test('react-native dismiss-overlay closes a collapsed banner at its own affordance, not at a Close over it', async () => {
  const sessionName = 'rn-session';
  const sessionStore = makeSessionStore();
  sessionStore.publish(sessionName, makeSession(sessionName));
  mockCaptureSnapshot.mockResolvedValue({
    snapshot: {
      nodes: [
        {
          index: 0,
          ref: 'e90',
          label: '!, Open debugger to view warnings.',
          rect: { x: 0, y: 794, width: 402, height: 52 },
          hittable: true,
        },
        {
          index: 1,
          ref: 'e91',
          type: 'Button',
          label: 'Close',
          rect: { x: 10, y: 803, width: 34, height: 34 },
          hittable: true,
        },
      ],
      createdAt: Date.now(),
    },
  });

  const response = await handleReactNativeCommands({
    createCommandSurface: fakeCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'react-native',
      positionals: ['dismiss-overlay'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
    contextFromFlags: () => ({}),
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(mockDismissTap).toHaveBeenCalledWith(
    expect.objectContaining({ point: { x: 379, y: 820 } }),
  );
  expect(response?.ok && response.data).toMatchObject({
    action: 'dismiss-overlay',
    overlayAction: 'close-collapsed-banner',
    ref: 'e90',
    x: 379,
    y: 820,
  });
});

test('react-native dismiss-overlay taps a collapsed banner whose badge shows the entry count', async () => {
  const sessionName = 'rn-count-badge-session';
  const sessionStore = makeSessionStore();
  sessionStore.publish(sessionName, makeSession(sessionName));
  mockCaptureSnapshot
    .mockResolvedValueOnce({
      snapshot: {
        nodes: [
          {
            index: 0,
            ref: 'e90',
            label: '20, Failed to fetch',
            rect: { x: 10, y: 787, width: 382, height: 48 },
            hittable: true,
          },
        ],
        viewport: snapshotViewportSizeFrom({ x: 0, y: 0, width: 402, height: 874 }),
        createdAt: Date.now(),
      },
    })
    .mockResolvedValueOnce({
      snapshot: {
        nodes: [
          {
            index: 0,
            ref: 'e1',
            label: 'Submit order',
            rect: { x: 24, y: 600, width: 180, height: 52 },
          },
        ],
        createdAt: Date.now(),
      },
    });

  const response = await handleReactNativeCommands({
    createCommandSurface: fakeCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'react-native',
      positionals: ['dismiss-overlay'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
    contextFromFlags: () => ({}),
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(mockDismissTap).toHaveBeenCalledWith(
    expect.objectContaining({ point: { x: 370, y: 811 } }),
  );
  expect(response?.ok && response.data).toMatchObject({
    action: 'dismiss-overlay',
    overlayAction: 'close-collapsed-banner',
    verified: true,
    x: 370,
    y: 811,
  });
});

test('react-native dismiss-overlay does not confuse app dismiss buttons with overlay controls', async () => {
  const sessionName = 'rn-collapsed-with-app-dismiss-session';
  const sessionStore = makeSessionStore();
  sessionStore.publish(sessionName, makeSession(sessionName));
  mockCaptureSnapshot
    .mockResolvedValueOnce({
      snapshot: {
        nodes: [
          {
            index: 0,
            ref: 'e20',
            label: 'Dismiss notice',
            rect: { x: 34, y: 839, width: 333, height: 45 },
            hittable: true,
          },
          {
            index: 1,
            ref: 'e50',
            label: '!, Agent Device RN overlay verification error',
            rect: { x: 10, y: 787, width: 382, height: 67 },
            hittable: true,
          },
        ],
        createdAt: Date.now(),
      },
    })
    .mockResolvedValueOnce({
      snapshot: {
        nodes: [
          {
            index: 0,
            ref: 'e1',
            label: 'Agent Device Tester',
            rect: { x: 18, y: 62, width: 366, height: 729 },
          },
        ],
        createdAt: Date.now(),
      },
    });

  const response = await handleReactNativeCommands({
    createCommandSurface: fakeCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'react-native',
      positionals: ['dismiss-overlay'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
    contextFromFlags: () => ({}),
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(mockDismissTap).toHaveBeenCalledWith(
    expect.objectContaining({ point: { x: 369, y: 813 } }),
  );
  expect(response?.ok && response.data).toMatchObject({
    action: 'dismiss-overlay',
    overlayAction: 'close-collapsed-banner',
    ref: 'e50',
    label: '!, Agent Device RN overlay verification error',
    verified: true,
    verificationRequired: false,
    x: 369,
    y: 813,
  });
});

test('react-native dismiss-overlay rejects unsafe collapsed warning coordinate fallback', async () => {
  const sessionName = 'rn-session';
  const sessionStore = makeSessionStore();
  sessionStore.publish(sessionName, makeSession(sessionName));
  mockCaptureSnapshot.mockResolvedValue({
    snapshot: {
      nodes: [
        {
          index: 0,
          ref: 'e90',
          label: 'Warning: Each child in a list should have a unique "key" prop.',
          rect: { x: 0, y: 794, width: 402, height: 52 },
          hittable: true,
        },
      ],
      createdAt: Date.now(),
    },
  });

  const response = await handleReactNativeCommands({
    createCommandSurface: fakeCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'react-native',
      positionals: ['dismiss-overlay'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
    contextFromFlags: () => ({}),
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(false);
  expect(mockDismissTap).not.toHaveBeenCalled();
  expect(!response?.ok && response?.error).toMatchObject({
    code: 'COMMAND_FAILED',
    details: {
      hint: expect.stringContaining('screenshot --overlay-refs'),
    },
  });
});

test('react-native dismiss-overlay dismisses the LogBox inspector instead of minimizing it', async () => {
  const sessionName = 'rn-redbox-session';
  const sessionStore = makeSessionStore();
  sessionStore.publish(sessionName, makeSession(sessionName));
  mockCaptureSnapshot
    .mockResolvedValueOnce({
      snapshot: {
        nodes: [
          {
            index: 0,
            ref: 'e1',
            label: 'Runtime Error',
            rect: { x: 0, y: 0, width: 390, height: 100 },
          },
          {
            index: 1,
            ref: 'e2',
            label: 'Dismiss',
            rect: { x: 0, y: 730, width: 130, height: 44 },
          },
          {
            index: 2,
            ref: 'e3',
            label: 'Minimize',
            rect: { x: 130, y: 730, width: 130, height: 44 },
          },
          {
            index: 3,
            ref: 'e4',
            label: 'Copy',
            rect: { x: 260, y: 730, width: 130, height: 44 },
          },
        ],
        viewport: snapshotViewportSizeFrom({ x: 0, y: 0, width: 390, height: 844 }),
        createdAt: Date.now(),
      },
    })
    .mockResolvedValueOnce({
      snapshot: {
        nodes: [],
        createdAt: Date.now(),
      },
    });

  const response = await handleReactNativeCommands({
    createCommandSurface: fakeCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'react-native',
      positionals: ['dismiss-overlay'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
    contextFromFlags: () => ({}),
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(mockDismissTap).toHaveBeenCalledWith(
    expect.objectContaining({ point: { x: 65, y: 752 } }),
  );
  expect(response?.ok && response.data).toMatchObject({
    action: 'dismiss-overlay',
    overlayAction: 'dismiss',
    ref: 'e2',
    dismissed: true,
    verified: true,
    verificationRequired: false,
    message: 'React Native overlay dismiss action sent and verified gone',
    x: 65,
    y: 752,
  });
  expect(response?.ok && response.data?.minimized).toBeUndefined();
});

test('react-native dismiss-overlay reports unverified dismiss when the inspector controls remain', async () => {
  const sessionName = 'rn-redbox-still-full-session';
  const sessionStore = makeSessionStore();
  sessionStore.publish(sessionName, makeSession(sessionName));
  const fullRedBoxSnapshot = {
    snapshot: {
      nodes: [
        {
          index: 0,
          ref: 'e1',
          label: 'Runtime Error',
          rect: { x: 0, y: 0, width: 390, height: 100 },
        },
        {
          index: 1,
          ref: 'e2',
          label: 'Dismiss',
          rect: { x: 0, y: 730, width: 130, height: 44 },
        },
        {
          index: 2,
          ref: 'e3',
          label: 'Minimize',
          rect: { x: 130, y: 730, width: 130, height: 44 },
        },
        {
          index: 3,
          ref: 'e4',
          label: 'Copy',
          rect: { x: 260, y: 730, width: 130, height: 44 },
        },
      ],
      viewport: snapshotViewportSizeFrom({ x: 0, y: 0, width: 390, height: 844 }),
      createdAt: Date.now(),
    },
  };
  mockCaptureSnapshot
    .mockResolvedValueOnce(fullRedBoxSnapshot)
    .mockResolvedValueOnce(fullRedBoxSnapshot);

  const response = await handleReactNativeCommands({
    createCommandSurface: fakeCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'react-native',
      positionals: ['dismiss-overlay'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
    contextFromFlags: () => ({}),
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(response?.ok && response.data).toMatchObject({
    action: 'dismiss-overlay',
    overlayAction: 'dismiss',
    dismissed: true,
    verified: false,
    verificationRequired: true,
    verificationWarning: expect.stringContaining('React Native overlay is still detected'),
    nextCommand: 'agent-device screenshot --overlay-refs',
    message: 'React Native overlay dismiss action sent, but verification still detects an overlay',
  });
});

test('react-native dismiss-overlay uses Dismiss when RedBox Minimize is absent', async () => {
  const sessionName = 'rn-redbox-dismiss-session';
  const sessionStore = makeSessionStore();
  sessionStore.publish(sessionName, makeSession(sessionName));
  mockCaptureSnapshot.mockResolvedValue({
    snapshot: {
      nodes: [
        {
          index: 0,
          ref: 'e1',
          label: 'Runtime Error',
          rect: { x: 0, y: 0, width: 390, height: 100 },
        },
        ...redBoxFooter(['Dismiss', 'Reload JS', 'Copy', 'Extra Info'], 730, 390),
      ],
      viewport: snapshotViewportSizeFrom({ x: 0, y: 0, width: 390, height: 844 }),
      createdAt: Date.now(),
    },
  });

  const response = await handleReactNativeCommands({
    createCommandSurface: fakeCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'react-native',
      positionals: ['dismiss-overlay'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
    contextFromFlags: () => ({}),
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(mockDismissTap).toHaveBeenCalledWith(
    expect.objectContaining({ point: { x: 49, y: 752 } }),
  );
  expect(response?.ok && response.data).toMatchObject({
    action: 'dismiss-overlay',
    overlayAction: 'dismiss',
    ref: 'e2',
  });
  expect(response?.ok && response.data?.warning).toBeUndefined();
});

test('react-native dismiss-overlay accepts RedBox control labels with keyboard shortcut suffixes', async () => {
  const sessionName = 'rn-redbox-shortcut-session';
  const sessionStore = makeSessionStore();
  sessionStore.publish(sessionName, makeSession(sessionName));
  mockCaptureSnapshot.mockResolvedValue({
    snapshot: {
      nodes: [
        {
          index: 0,
          ref: 'e1',
          label: 'Runtime Error: NativeModule is null',
          rect: { x: 0, y: 0, width: 390, height: 620 },
        },
        ...redBoxFooter(
          ['Dismiss (ESC)', 'Reload JS (⌘R)', 'Copy (⌥⌘C)', 'Extra Info (⌘E)'],
          700,
          390,
        ),
      ],
      viewport: snapshotViewportSizeFrom({ x: 0, y: 0, width: 390, height: 844 }),
      createdAt: Date.now(),
    },
  });

  const response = await handleReactNativeCommands({
    createCommandSurface: fakeCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'react-native',
      positionals: ['dismiss-overlay'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
    contextFromFlags: () => ({}),
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(mockDismissTap).toHaveBeenCalledWith(
    expect.objectContaining({ point: { x: 49, y: 722 } }),
  );
  expect(response?.ok && response.data).toMatchObject({
    action: 'dismiss-overlay',
    overlayAction: 'dismiss',
    ref: 'e2',
  });
  expect(response?.ok && response.data?.warning).toBeUndefined();
});

test('react-native dismiss-overlay prefers concrete RedBox buttons over labeled wrappers', async () => {
  const sessionName = 'rn-redbox-wrapper-session';
  const sessionStore = makeSessionStore();
  sessionStore.publish(sessionName, makeSession(sessionName));
  mockCaptureSnapshot.mockResolvedValue({
    snapshot: {
      nodes: [
        {
          index: 0,
          ref: 'e1',
          label: 'Runtime Error: NativeModule is null',
          rect: { x: 0, y: 0, width: 402, height: 720 },
        },
        {
          index: 1,
          ref: 'e42',
          type: 'XCUIElementTypeOther',
          label: 'Dismiss (ESC)',
          rect: { x: 0, y: 802, width: 402, height: 50 },
        },
        {
          index: 2,
          ref: 'e43',
          type: 'XCUIElementTypeButton',
          label: 'Dismiss (ESC)',
          rect: { x: 0, y: 805, width: 100.5, height: 44 },
        },
        {
          index: 3,
          ref: 'e44',
          type: 'XCUIElementTypeButton',
          label: 'Reload JS (⌘R)',
          rect: { x: 100.5, y: 805, width: 100.5, height: 44 },
        },
        {
          index: 4,
          ref: 'e45',
          type: 'XCUIElementTypeButton',
          label: 'Copy (⌥⌘C)',
          rect: { x: 201, y: 805, width: 100.5, height: 44 },
        },
        {
          index: 5,
          ref: 'e46',
          type: 'XCUIElementTypeButton',
          label: 'Extra Info (⌘E)',
          rect: { x: 301.5, y: 805, width: 100.5, height: 44 },
        },
      ],
      viewport: snapshotViewportSizeFrom({ x: 0, y: 0, width: 402, height: 874 }),
      createdAt: Date.now(),
    },
  });

  const response = await handleReactNativeCommands({
    createCommandSurface: fakeCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'react-native',
      positionals: ['dismiss-overlay'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
    contextFromFlags: () => ({}),
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(response?.ok && response.data).toMatchObject({
    action: 'dismiss-overlay',
    overlayAction: 'dismiss',
    ref: 'e43',
    x: 50,
    y: 827,
  });
});

test('react-native dismiss-overlay reports verified success after a clean post-dismiss snapshot', async () => {
  const sessionName = 'rn-verify-session';
  const sessionStore = makeSessionStore();
  sessionStore.publish(sessionName, makeSession(sessionName, 'android'));
  mockCaptureSnapshot
    .mockResolvedValueOnce({
      snapshot: {
        nodes: [
          {
            index: 0,
            ref: 'e1',
            label: '!, Warning: Failed prop type',
            rect: { x: 10, y: 640, width: 370, height: 48 },
          },
        ],
        createdAt: Date.now(),
      },
    })
    .mockResolvedValueOnce({
      snapshot: {
        nodes: [
          {
            index: 0,
            ref: 'e1',
            label: 'Submit order',
            rect: { x: 24, y: 600, width: 180, height: 52 },
          },
        ],
        createdAt: Date.now(),
      },
    });

  const response = await handleReactNativeCommands({
    createCommandSurface: fakeCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'react-native',
      positionals: ['dismiss-overlay'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
    contextFromFlags: () => ({}),
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) throw new Error('Expected react-native dismiss-overlay to succeed');
  if (!response.data) throw new Error('Expected react-native dismiss-overlay response data');
  expect(mockCaptureSnapshot).toHaveBeenCalledTimes(2);
  expect(response.data).toMatchObject({
    action: 'dismiss-overlay',
    overlayAction: 'close-collapsed-banner',
    verified: true,
    verificationRequired: false,
  });
  expect(response.data.nextCommand).toBeUndefined();
});

test('react-native dismiss-overlay reports sparse verdict instead of no overlay detected', async () => {
  const sessionName = 'rn-sparse-session';
  const sessionStore = makeSessionStore();
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: [
      {
        index: 0,
        ref: 'e1',
        label: 'Previous screen action',
        rect: { x: 24, y: 600, width: 180, height: 52 },
      },
    ],
    createdAt: Date.now(),
  };
  const previousSnapshot = session.snapshot;
  sessionStore.publish(sessionName, session);
  mockCaptureSnapshot.mockResolvedValue({
    snapshot: {
      nodes: [
        {
          index: 0,
          ref: 'e1',
          type: 'Application',
        },
      ],
      createdAt: Date.now(),
      snapshotQuality: {
        state: 'sparse',
        backend: 'private-ax',
        reason: 'sparse tree',
        reasonCode: 'sparse-tree',
      },
    },
  });

  const response = await handleReactNativeCommands({
    createCommandSurface: fakeCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'react-native',
      positionals: ['dismiss-overlay'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
    contextFromFlags: () => ({}),
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(false);
  expect(session.snapshot).toBe(previousSnapshot);
  expect(mockDismissTap).not.toHaveBeenCalled();
  expect(!response?.ok && response?.error).toMatchObject({
    code: 'COMMAND_FAILED',
    message:
      'React Native overlay state could not be determined because the accessibility tree is unreadable',
    details: {
      reason: 'overlay_snapshot_unreadable',
      verdictReason: 'sparse tree',
      verdictReasonCode: 'sparse-tree',
      hint: expect.stringContaining('snapshot quality verdict is sparse'),
    },
  });
});

test('react-native dismiss-overlay reports unverified dismiss when post-dismiss snapshot is sparse', async () => {
  const sessionName = 'rn-verify-sparse-session';
  const sessionStore = makeSessionStore();
  sessionStore.publish(sessionName, makeSession(sessionName));
  mockCaptureSnapshot
    .mockResolvedValueOnce({
      snapshot: {
        nodes: [
          {
            index: 0,
            ref: 'e1',
            label: '!, Warning: Failed prop type',
            rect: { x: 10, y: 640, width: 370, height: 48 },
          },
        ],
        createdAt: Date.now(),
      },
    })
    .mockResolvedValueOnce({
      snapshot: {
        nodes: [
          {
            index: 0,
            ref: 'e1',
            type: 'Application',
          },
        ],
        createdAt: Date.now(),
        snapshotQuality: {
          state: 'sparse',
          backend: 'private-ax',
          reason: 'sparse tree',
          reasonCode: 'sparse-tree',
        },
      },
    });

  const response = await handleReactNativeCommands({
    createCommandSurface: fakeCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'react-native',
      positionals: ['dismiss-overlay'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
    contextFromFlags: () => ({}),
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(response?.ok && response.data).toMatchObject({
    action: 'dismiss-overlay',
    verified: false,
    verificationRequired: true,
    verificationWarning: expect.stringContaining('accessibility tree is unreadable'),
    nextCommand: 'agent-device screenshot',
  });
});

test('react-native dismiss-overlay reports still-visible overlays with recovery guidance', async () => {
  const sessionName = 'rn-verify-still-visible-session';
  const sessionStore = makeSessionStore();
  sessionStore.publish(sessionName, makeSession(sessionName, 'android'));
  const overlaySnapshot = {
    snapshot: {
      nodes: [
        {
          index: 0,
          ref: 'e1',
          label: '!, Warning: Failed prop type',
          rect: { x: 10, y: 640, width: 370, height: 48 },
        },
      ],
      createdAt: Date.now(),
    },
  };
  mockCaptureSnapshot.mockResolvedValueOnce(overlaySnapshot).mockResolvedValueOnce(overlaySnapshot);

  const response = await handleReactNativeCommands({
    createCommandSurface: fakeCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'react-native',
      positionals: ['dismiss-overlay'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
    contextFromFlags: () => ({}),
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(response?.ok && response.data).toMatchObject({
    action: 'dismiss-overlay',
    verified: false,
    verificationRequired: true,
    verificationWarning: expect.stringContaining('screenshot --overlay-refs'),
    nextCommand: 'agent-device screenshot --overlay-refs',
  });
});

test('react-native dismiss-overlay ignores app copy that only mentions RN overlay terms', async () => {
  const sessionName = 'rn-copy-session';
  const sessionStore = makeSessionStore();
  sessionStore.publish(sessionName, makeSession(sessionName));
  mockCaptureSnapshot.mockResolvedValue({
    snapshot: {
      nodes: [
        {
          index: 0,
          ref: 'e1',
          label: 'Runtime error troubleshooting docs mention LogBox and RedBox',
          rect: { x: 0, y: 100, width: 390, height: 80 },
        },
      ],
      createdAt: Date.now(),
    },
  });

  const response = await handleReactNativeCommands({
    createCommandSurface: fakeCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'react-native',
      positionals: ['dismiss-overlay'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
    contextFromFlags: () => ({}),
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(mockDismissTap).not.toHaveBeenCalled();
  expect(response?.ok && response.data).toMatchObject({
    action: 'dismiss-overlay',
    detected: false,
    dismissed: false,
  });
});

function makeSessionStore(): SessionStore {
  const root = mkdtempForTestSync('agent-device-rn-handler-');
  return new SessionStore(path.join(root, 'sessions'), createLiveTestHostEnvironment());
}

function makeSession(name: string, platform: 'ios' | 'android' = 'ios'): SessionState {
  return {
    name,
    createdAt: Date.now(),
    actions: [],
    device: {
      platform: platform === 'ios' ? 'apple' : 'android',
      id: 'sim-1',
      name: platform === 'ios' ? 'iPhone' : 'Pixel',
      kind: platform === 'ios' ? 'simulator' : 'emulator',
      booted: true,
    },
  };
}
