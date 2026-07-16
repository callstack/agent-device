import { test, expect, vi, beforeEach } from 'vitest';
import { handleFindCommands } from '../find.ts';
import { dispatchFindReadOnlyViaRuntime, dispatchWaitViaRuntime } from '../../selector-runtime.ts';
import type { DaemonRequest, DaemonResponse } from '../../types.ts';
import { ANDROID_SYSTEM_SURFACE_DISCLOSURE } from '../../../snapshot/system-surface-disclosure.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { makeAndroidSession } from '../../../__tests__/test-utils/session-factories.ts';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchCommand: vi.fn(async () => ({})),
    resolveTargetDevice: vi.fn(actual.resolveTargetDevice),
  };
});

vi.mock('../../device-ready.ts', () => ({
  ensureDeviceReady: vi.fn(async () => {}),
}));

import { dispatchCommand, resolveTargetDevice } from '../../../core/dispatch.ts';
import { ANDROID_EMULATOR } from '../../../__tests__/test-utils/index.ts';
import { withSystemSurfaceDisclosure } from '../system-surface-disclosure.ts';

const mockDispatch = vi.mocked(dispatchCommand);

// The occluding-shade capture every scenario below consumes: no application window content, one
// active quick-settings surface. The Android capture route stamps systemSurfaceOnly on both the
// annotations and the SnapshotState (see snapshot-capture.ts), so selector routes must disclose it.
const SHADE_SNAPSHOT_DATA = {
  backend: 'android',
  nodes: [
    {
      index: 0,
      depth: 0,
      type: 'FrameLayout',
      label: 'Quick settings',
      rect: { x: 0, y: 0, width: 390, height: 844 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Switch',
      label: 'Internet',
      hittable: true,
      rect: { x: 24, y: 120, width: 156, height: 80 },
    },
  ],
  androidSnapshot: { backend: 'android-helper', systemSurfaceOnly: true },
};

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockImplementation(async (_device: unknown, command: string) => {
    return command === 'snapshot' ? SHADE_SNAPSHOT_DATA : {};
  });
});

test('mutating find on a system-surface capture discloses the occlusion on the found outcome', async () => {
  const sessionStore = makeSessionStore();
  const session = makeAndroidSession('default');
  sessionStore.set('default', session);

  const response = await handleFindCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'find',
      positionals: ['Internet', 'click'],
      flags: {},
    },
    sessionName: 'default',
    logPath: '/tmp/test.log',
    sessionStore,
    invoke: async () => ({ ok: true, data: {} }) as DaemonResponse,
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;
  expect(String((response.data as Record<string, unknown>).warning)).toContain(
    ANDROID_SYSTEM_SURFACE_DISCLOSURE,
  );
});

test('read-only find exists on a system-surface capture discloses the occlusion', async () => {
  const sessionStore = makeSessionStore();
  const session = makeAndroidSession('default');
  sessionStore.set('default', session);

  const response = await dispatchFindReadOnlyViaRuntime({
    req: {
      token: 't',
      session: 'default',
      command: 'find',
      positionals: ['Internet', 'exists'],
      flags: {},
    } as DaemonRequest,
    sessionName: 'default',
    logPath: '/tmp/test.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;
  const data = response.data as Record<string, unknown>;
  expect(data.found).toBe(true);
  expect(String(data.warning)).toContain(ANDROID_SYSTEM_SURFACE_DISCLOSURE);
});

test('wait timeout for app text hidden behind a system surface discloses the occlusion', async () => {
  const sessionStore = makeSessionStore();
  const session = makeAndroidSession('default');
  sessionStore.set('default', session);

  const response = await dispatchWaitViaRuntime({
    req: {
      token: 't',
      session: 'default',
      command: 'wait',
      positionals: ['Bakery list', '250'],
      flags: {},
    } as DaemonRequest,
    sessionName: 'default',
    logPath: '/tmp/test.log',
    sessionStore,
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.message).toMatch(/wait timed out for text: Bakery list/);
  expect(String(response.error.details?.hint)).toContain(ANDROID_SYSTEM_SURFACE_DISCLOSURE);
});

test('sessionless read-only find still discloses the occluding system surface', async () => {
  vi.mocked(resolveTargetDevice).mockResolvedValueOnce(ANDROID_EMULATOR);
  const sessionStore = makeSessionStore();

  const response = await dispatchFindReadOnlyViaRuntime({
    req: {
      token: 't',
      session: 'default',
      command: 'find',
      positionals: ['Internet', 'exists'],
      flags: {},
    } as DaemonRequest,
    sessionName: 'default',
    logPath: '/tmp/test.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;
  const data = response.data as Record<string, unknown>;
  expect(data.found).toBe(true);
  // No session record exists to read the capture back from: the disclosure must come from the
  // consumed capture itself.
  expect(sessionStore.get('default')).toBeUndefined();
  expect(String(data.warning)).toContain(ANDROID_SYSTEM_SURFACE_DISCLOSURE);
});

test('disclosure appends after an existing success warning instead of replacing it', () => {
  const response = withSystemSurfaceDisclosure(
    { ok: true, data: { found: true, warning: 'prior warning text' } },
    { systemSurfaceOnly: true },
  );
  expect(response.ok).toBe(true);
  if (!response.ok) return;
  const warning = String((response.data as Record<string, unknown>).warning);
  expect(warning).toContain('prior warning text');
  expect(warning).toContain(ANDROID_SYSTEM_SURFACE_DISCLOSURE);
  expect(warning.indexOf('prior warning text')).toBeLessThan(
    warning.indexOf(ANDROID_SYSTEM_SURFACE_DISCLOSURE),
  );
});

test('disclosure appends after an existing failure hint instead of replacing it', () => {
  const response = withSystemSurfaceDisclosure(
    {
      ok: false,
      error: { code: 'NOT_FOUND', message: 'no match', details: { hint: 'prior hint text' } },
    },
    { systemSurfaceOnly: true },
  );
  expect(response.ok).toBe(false);
  if (response.ok) return;
  const hint = String(response.error.details?.hint);
  expect(hint).toContain('prior hint text');
  expect(hint).toContain(ANDROID_SYSTEM_SURFACE_DISCLOSURE);
  expect(hint.indexOf('prior hint text')).toBeLessThan(
    hint.indexOf(ANDROID_SYSTEM_SURFACE_DISCLOSURE),
  );
});

test('sessionless wait success on shade content still discloses the occluding system surface', async () => {
  vi.mocked(resolveTargetDevice).mockResolvedValueOnce(ANDROID_EMULATOR);
  const sessionStore = makeSessionStore();

  const response = await dispatchWaitViaRuntime({
    req: {
      token: 't',
      session: 'default',
      command: 'wait',
      positionals: ['Internet', '250'],
      flags: {},
    } as DaemonRequest,
    sessionName: 'default',
    logPath: '/tmp/test.log',
    sessionStore,
  });

  expect(response.ok).toBe(true);
  if (!response.ok) return;
  expect(sessionStore.get('default')).toBeUndefined();
  expect(String((response.data as Record<string, unknown>).warning)).toContain(
    ANDROID_SYSTEM_SURFACE_DISCLOSURE,
  );
});

test('sessionless wait timeout still discloses the occluding system surface', async () => {
  vi.mocked(resolveTargetDevice).mockResolvedValueOnce(ANDROID_EMULATOR);
  const sessionStore = makeSessionStore();

  const response = await dispatchWaitViaRuntime({
    req: {
      token: 't',
      session: 'default',
      command: 'wait',
      positionals: ['Bakery list', '250'],
      flags: {},
    } as DaemonRequest,
    sessionName: 'default',
    logPath: '/tmp/test.log',
    sessionStore,
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(sessionStore.get('default')).toBeUndefined();
  expect(String(response.error.details?.hint)).toContain(ANDROID_SYSTEM_SURFACE_DISCLOSURE);
});
