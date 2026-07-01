import { beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleReactNativeCommands } from '../react-native.ts';
import { captureSnapshot } from '../snapshot-capture.ts';
import { dispatchCommand } from '../../../core/dispatch.ts';
import { SessionStore } from '../../session-store.ts';
import type { SessionState } from '../../types.ts';

vi.mock('../snapshot-capture.ts', () => ({
  captureSnapshot: vi.fn(),
}));

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchCommand: vi.fn(async () => ({ x: 379, y: 820 })),
  };
});

const mockCaptureSnapshot = vi.mocked(captureSnapshot);
const mockDispatchCommand = vi.mocked(dispatchCommand);

beforeEach(() => {
  mockCaptureSnapshot.mockReset();
  mockDispatchCommand.mockReset();
  mockDispatchCommand.mockResolvedValue({ x: 379, y: 820 });
});

test('react-native dismiss-overlay taps collapsed warning close affordance instead of banner center', async () => {
  const sessionName = 'rn-session';
  const sessionStore = makeSessionStore();
  sessionStore.set(sessionName, makeSession(sessionName));
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
  });

  expect(response?.ok).toBe(true);
  expect(mockDispatchCommand).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'apple' }),
    'press',
    ['379', '820'],
    undefined,
    expect.any(Object),
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

test('react-native dismiss-overlay prefers non-trailing collapsed warning close controls', async () => {
  const sessionName = 'rn-session';
  const sessionStore = makeSessionStore();
  sessionStore.set(sessionName, makeSession(sessionName));
  mockDispatchCommand.mockResolvedValue({ x: 27, y: 820 });
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
          label: 'Close',
          rect: { x: 10, y: 803, width: 34, height: 34 },
          hittable: true,
        },
      ],
      createdAt: Date.now(),
    },
  });

  const response = await handleReactNativeCommands({
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
  });

  expect(response?.ok).toBe(true);
  expect(mockDispatchCommand).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'apple' }),
    'press',
    ['27', '820'],
    undefined,
    expect.any(Object),
  );
  expect(response?.ok && response.data).toMatchObject({
    action: 'dismiss-overlay',
    overlayAction: 'close',
    ref: 'e91',
    x: 27,
    y: 820,
  });
});

test('react-native dismiss-overlay does not confuse app dismiss buttons with overlay controls', async () => {
  const sessionName = 'rn-collapsed-with-app-dismiss-session';
  const sessionStore = makeSessionStore();
  sessionStore.set(sessionName, makeSession(sessionName));
  mockDispatchCommand.mockResolvedValue({ x: 379, y: 820 });
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
  });

  expect(response?.ok).toBe(true);
  expect(mockDispatchCommand).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'apple' }),
    'press',
    ['369', '813'],
    undefined,
    expect.any(Object),
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
  sessionStore.set(sessionName, makeSession(sessionName));
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
  });

  expect(response?.ok).toBe(false);
  expect(mockDispatchCommand).not.toHaveBeenCalled();
  expect(!response?.ok && response?.error).toMatchObject({
    code: 'COMMAND_FAILED',
    details: {
      hint: expect.stringContaining('screenshot --overlay-refs'),
    },
  });
});

test('react-native dismiss-overlay dismisses RedBox error overlays instead of minimizing them', async () => {
  const sessionName = 'rn-redbox-session';
  const sessionStore = makeSessionStore();
  sessionStore.set(sessionName, makeSession(sessionName));
  mockDispatchCommand.mockResolvedValue({ x: 95, y: 752 });
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
            rect: { x: 20, y: 730, width: 150, height: 44 },
          },
          {
            index: 2,
            ref: 'e3',
            label: 'Minimize',
            rect: { x: 190, y: 730, width: 150, height: 44 },
          },
        ],
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
  });

  expect(response?.ok).toBe(true);
  expect(mockDispatchCommand).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'apple' }),
    'press',
    ['95', '752'],
    undefined,
    expect.any(Object),
  );
  expect(response?.ok && response.data).toMatchObject({
    action: 'dismiss-overlay',
    overlayAction: 'dismiss',
    ref: 'e2',
    dismissed: true,
    verified: true,
    verificationRequired: false,
    message: 'React Native overlay dismiss action sent and verified gone',
    x: 95,
    y: 752,
  });
  expect(response?.ok && response.data?.minimized).toBeUndefined();
});

test('react-native dismiss-overlay reports unverified dismiss when RedBox controls remain', async () => {
  const sessionName = 'rn-redbox-still-full-session';
  const sessionStore = makeSessionStore();
  sessionStore.set(sessionName, makeSession(sessionName));
  mockDispatchCommand.mockResolvedValue({ x: 95, y: 752 });
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
          rect: { x: 20, y: 730, width: 150, height: 44 },
        },
        {
          index: 2,
          ref: 'e3',
          label: 'Minimize',
          rect: { x: 190, y: 730, width: 150, height: 44 },
        },
      ],
      createdAt: Date.now(),
    },
  };
  mockCaptureSnapshot
    .mockResolvedValueOnce(fullRedBoxSnapshot)
    .mockResolvedValueOnce(fullRedBoxSnapshot);

  const response = await handleReactNativeCommands({
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
  sessionStore.set(sessionName, makeSession(sessionName));
  mockDispatchCommand.mockResolvedValue({ x: 95, y: 752 });
  mockCaptureSnapshot.mockResolvedValue({
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
          rect: { x: 20, y: 730, width: 150, height: 44 },
        },
      ],
      createdAt: Date.now(),
    },
  });

  const response = await handleReactNativeCommands({
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
  });

  expect(response?.ok).toBe(true);
  expect(mockDispatchCommand).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'apple' }),
    'press',
    ['95', '752'],
    undefined,
    expect.any(Object),
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
  sessionStore.set(sessionName, makeSession(sessionName));
  mockDispatchCommand.mockResolvedValue({ x: 70, y: 722 });
  mockCaptureSnapshot.mockResolvedValue({
    snapshot: {
      nodes: [
        {
          index: 0,
          ref: 'e1',
          label: 'Runtime Error: NativeModule is null',
          rect: { x: 0, y: 0, width: 390, height: 620 },
        },
        {
          index: 1,
          ref: 'e2',
          label: 'Dismiss (ESC)',
          rect: { x: 18, y: 700, width: 104, height: 44 },
        },
      ],
      createdAt: Date.now(),
    },
  });

  const response = await handleReactNativeCommands({
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
  });

  expect(response?.ok).toBe(true);
  expect(mockDispatchCommand).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'apple' }),
    'press',
    ['70', '722'],
    undefined,
    expect.any(Object),
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
  sessionStore.set(sessionName, makeSession(sessionName));
  mockDispatchCommand.mockResolvedValue({ x: 201, y: 827 });
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
          rect: { x: 156, y: 805, width: 90, height: 44 },
        },
      ],
      createdAt: Date.now(),
    },
  });

  const response = await handleReactNativeCommands({
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
  });

  expect(response?.ok).toBe(true);
  expect(response?.ok && response.data).toMatchObject({
    action: 'dismiss-overlay',
    overlayAction: 'dismiss',
    ref: 'e43',
    x: 201,
    y: 827,
  });
});

test('react-native dismiss-overlay reports verified success after a clean post-dismiss snapshot', async () => {
  const sessionName = 'rn-verify-session';
  const sessionStore = makeSessionStore();
  sessionStore.set(sessionName, makeSession(sessionName, 'android'));
  mockDispatchCommand.mockResolvedValue({ x: 105, y: 714 });
  mockCaptureSnapshot
    .mockResolvedValueOnce({
      snapshot: {
        nodes: [
          {
            index: 0,
            ref: 'e1',
            label: 'LogBox',
            rect: { x: 0, y: 640, width: 390, height: 120 },
          },
          {
            index: 1,
            ref: 'e2',
            label: 'Close',
            rect: { x: 84, y: 692, width: 42, height: 44 },
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
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) throw new Error('Expected react-native dismiss-overlay to succeed');
  if (!response.data) throw new Error('Expected react-native dismiss-overlay response data');
  expect(mockCaptureSnapshot).toHaveBeenCalledTimes(2);
  expect(response.data).toMatchObject({
    action: 'dismiss-overlay',
    overlayAction: 'close',
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
  sessionStore.set(sessionName, session);
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
  });

  expect(response?.ok).toBe(false);
  expect(session.snapshot).toBe(previousSnapshot);
  expect(mockDispatchCommand).not.toHaveBeenCalled();
  expect(!response?.ok && response?.error).toMatchObject({
    code: 'COMMAND_FAILED',
    message:
      'React Native overlay state could not be determined because the accessibility tree is unreadable',
    details: {
      reason: 'sparse tree',
      hint: expect.stringContaining('snapshot quality verdict is sparse'),
    },
  });
});

test('react-native dismiss-overlay reports unverified dismiss when post-dismiss snapshot is sparse', async () => {
  const sessionName = 'rn-verify-sparse-session';
  const sessionStore = makeSessionStore();
  sessionStore.set(sessionName, makeSession(sessionName));
  mockDispatchCommand.mockResolvedValue({ x: 105, y: 714 });
  mockCaptureSnapshot
    .mockResolvedValueOnce({
      snapshot: {
        nodes: [
          {
            index: 0,
            ref: 'e1',
            label: 'LogBox',
            rect: { x: 0, y: 640, width: 390, height: 120 },
          },
          {
            index: 1,
            ref: 'e2',
            label: 'Close',
            rect: { x: 84, y: 692, width: 42, height: 44 },
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
  sessionStore.set(sessionName, makeSession(sessionName, 'android'));
  mockDispatchCommand.mockResolvedValue({ x: 105, y: 714 });
  const overlaySnapshot = {
    snapshot: {
      nodes: [
        {
          index: 0,
          ref: 'e1',
          label: 'LogBox',
          rect: { x: 0, y: 640, width: 390, height: 120 },
        },
        {
          index: 1,
          ref: 'e2',
          label: 'Close',
          rect: { x: 84, y: 692, width: 42, height: 44 },
        },
      ],
      createdAt: Date.now(),
    },
  };
  mockCaptureSnapshot.mockResolvedValueOnce(overlaySnapshot).mockResolvedValueOnce(overlaySnapshot);

  const response = await handleReactNativeCommands({
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
  sessionStore.set(sessionName, makeSession(sessionName));
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
  });

  expect(response?.ok).toBe(true);
  expect(mockDispatchCommand).not.toHaveBeenCalled();
  expect(response?.ok && response.data).toMatchObject({
    action: 'dismiss-overlay',
    detected: false,
    dismissed: false,
  });
});

function makeSessionStore(): SessionStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-rn-handler-'));
  return new SessionStore(path.join(root, 'sessions'));
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
