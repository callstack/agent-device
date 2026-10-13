import { vi } from 'vitest';
import type {
  CreateDaemonCommandSurface,
  DaemonCommandSurface,
} from '@agent-device/contracts/daemon-command-surface';

/**
 * The `CreateDaemonCommandSurface` port as the daemon-policy suites need it. Router and handler
 * suites assert the daemon's own decisions — admission, locking, session policy, response
 * shaping — and mock one level below the surface (bound operations, capture doubles), so this
 * fake answers with inert shapes and refuses the selector reads loudly: a suite whose request
 * starts executing real selector code depends on root command behavior and belongs under
 * `src/__tests__/daemon-composition/` behind the real `testCreateCommandSurface`, where its
 * assertions keep their meaning.
 */
const fakeCommandSurface: DaemonCommandSurface = {
  capture: {
    screenshot: vi.fn(async () => ({ path: '/tmp/fake-screenshot.png' })),
    snapshot: vi.fn(async () => ({ nodes: [] })),
    diffSnapshot: vi.fn(async () => ({
      mode: 'snapshot' as const,
      baselineInitialized: false,
      summary: { additions: 0, removals: 0, unchanged: 0 },
      lines: [],
    })),
  },
  selectors: {
    find: vi.fn(async () => {
      throw new Error('fake command surface: selector `find` must not run in daemon-policy tests');
    }),
    get: vi.fn(async () => {
      throw new Error('fake command surface: selector `get` must not run in daemon-policy tests');
    }),
    is: vi.fn(async () => {
      throw new Error('fake command surface: selector `is` must not run in daemon-policy tests');
    }),
    wait: vi.fn(async () => {
      throw new Error('fake command surface: `wait` must not run in daemon-policy tests');
    }),
    waitForText: vi.fn(async () => {
      throw new Error('fake command surface: `waitForText` must not run in daemon-policy tests');
    }),
  },
  interactions: {
    click: vi.fn(async () => undefined as never),
    press: vi.fn(async () => undefined as never),
    fill: vi.fn(async () => undefined as never),
    longPress: vi.fn(async () => undefined as never),
    hover: vi.fn(async () => undefined as never),
    gesture: vi.fn(
      async () =>
        ({
          kind: 'fling',
          durationMs: 1,
          pointerCount: 1,
          from: { x: 0, y: 0 },
          to: { x: 1, y: 1 },
        }) as never,
    ),
    settleObservation: vi.fn(async () => ({ stable: true, waitedMs: 0 }) as never),
  },
};

/** The port value the daemon-policy suites inject; see {@link fakeCommandSurface}. */
export const fakeCreateCommandSurface: CreateDaemonCommandSurface = async () => fakeCommandSurface;
