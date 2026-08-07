import { beforeEach, expect, test, vi } from 'vitest';

const resolveSoleForegroundIosApp = vi.hoisted(() => vi.fn());
const dispatchSnapshotViaRuntime = vi.hoisted(() => vi.fn());

vi.mock('../../ios-app-session-hint.ts', () => ({ resolveSoleForegroundIosApp }));
vi.mock('../../snapshot-runtime.ts', () => ({ dispatchSnapshotViaRuntime }));

import { IOS_SIMULATOR } from '../../../__tests__/test-utils/index.ts';
import type { DaemonRequest, DaemonResponse } from '../../types.ts';
import {
  composeOpenWithInitialSnapshot,
  resolveForegroundOpenRequest,
} from '../session-open-foreground.ts';

function baseRequest(overrides: Partial<DaemonRequest> = {}): DaemonRequest {
  return {
    token: 't',
    session: 'default',
    command: 'open',
    positionals: [],
    flags: {},
    ...overrides,
  };
}

beforeEach(() => {
  resolveSoleForegroundIosApp.mockReset();
  dispatchSnapshotViaRuntime.mockReset();
});

// --- resolveForegroundOpenRequest ---

test('leaves the request untouched when --foreground was not requested', async () => {
  const resolution = await resolveForegroundOpenRequest({
    req: baseRequest(),
    hasExistingSession: false,
  });

  expect(resolution).toEqual({ type: 'not-requested' });
  expect(resolveSoleForegroundIosApp).not.toHaveBeenCalled();
});

test('rejects --foreground against an existing session', async () => {
  const resolution = await resolveForegroundOpenRequest({
    req: baseRequest({ flags: { foreground: true } }),
    hasExistingSession: true,
  });

  expect(resolution.type).toBe('response');
  if (resolution.type === 'response') {
    expect(resolution.response.ok).toBe(false);
    if (!resolution.response.ok) {
      expect(resolution.response.error.code).toBe('INVALID_ARGS');
    }
  }
  expect(resolveSoleForegroundIosApp).not.toHaveBeenCalled();
});

test('rejects --foreground combined with an explicit app argument', async () => {
  const resolution = await resolveForegroundOpenRequest({
    req: baseRequest({ flags: { foreground: true }, positionals: ['com.example.demo'] }),
    hasExistingSession: false,
  });

  expect(resolution.type).toBe('response');
  if (resolution.type === 'response') {
    expect(resolution.response.ok).toBe(false);
    if (!resolution.response.ok) {
      expect(resolution.response.error.code).toBe('INVALID_ARGS');
    }
  }
  expect(resolveSoleForegroundIosApp).not.toHaveBeenCalled();
});

test('an unambiguous environment rewrites positionals and pins the resolved device', async () => {
  const soleBootedDevice = { ...IOS_SIMULATOR, id: 'booted-1', name: 'iPhone 16' };
  resolveSoleForegroundIosApp.mockResolvedValue({
    device: soleBootedDevice,
    app: { bundleId: 'xyz.blueskyweb.app', name: 'Bluesky' },
  });

  const resolution = await resolveForegroundOpenRequest({
    req: baseRequest({ flags: { foreground: true, iosSimulatorDeviceSet: '/custom/set' } }),
    hasExistingSession: false,
  });

  expect(resolution).toEqual({
    type: 'resolved',
    req: baseRequest({
      flags: {
        foreground: true,
        iosSimulatorDeviceSet: '/custom/set',
        udid: 'booted-1',
        platform: 'ios',
      },
      positionals: ['xyz.blueskyweb.app'],
    }),
  });
  expect(resolveSoleForegroundIosApp).toHaveBeenCalledWith({ simulatorSetPath: '/custom/set' });
});

test('an ambiguous environment fails closed with AMBIGUOUS_MATCH instead of guessing', async () => {
  resolveSoleForegroundIosApp.mockResolvedValue(undefined);

  const resolution = await resolveForegroundOpenRequest({
    req: baseRequest({ flags: { foreground: true } }),
    hasExistingSession: false,
  });

  expect(resolution.type).toBe('response');
  if (resolution.type === 'response') {
    expect(resolution.response.ok).toBe(false);
    if (!resolution.response.ok) {
      expect(resolution.response.error.code).toBe('AMBIGUOUS_MATCH');
      expect(resolution.response.error.details?.reason).toBe('foreground_app_ambiguous');
      expect(resolution.response.error.details?.hint).toMatch(/agent-device open <app>/);
    }
  }
});

test('a probe failure fails closed like ambiguity, never silently succeeds', async () => {
  // The resolver owns the catch-all (see resolveSoleForegroundIosApp): a
  // rejecting simctl/launchctl probe surfaces as `undefined`, which this
  // handler must treat exactly like ambiguity — a hard AMBIGUOUS_MATCH, not
  // a guessed target.
  resolveSoleForegroundIosApp.mockResolvedValue(undefined);

  const resolution = await resolveForegroundOpenRequest({
    req: baseRequest({ flags: { foreground: true } }),
    hasExistingSession: false,
  });

  expect(resolution.type).toBe('response');
  if (resolution.type === 'response') {
    expect(resolution.response.ok).toBe(false);
    if (!resolution.response.ok) {
      expect(resolution.response.error.code).toBe('AMBIGUOUS_MATCH');
    }
  }
});

// --- composeOpenWithInitialSnapshot ---

const okOpenResponse: DaemonResponse = { ok: true, data: { session: 'default' } };
const failedOpenResponse: DaemonResponse = {
  ok: false,
  error: { code: 'AMBIGUOUS_MATCH', message: 'nope' },
};

test('passes a failed open response through untouched', async () => {
  const result = await composeOpenWithInitialSnapshot({
    req: baseRequest({ flags: { foreground: true } }),
    sessionName: 'default',
    logPath: '/tmp/daemon.log',
    sessionStore: {} as never,
    openResponse: failedOpenResponse,
  });

  expect(result).toBe(failedOpenResponse);
  expect(dispatchSnapshotViaRuntime).not.toHaveBeenCalled();
});

test('leaves a successful open response untouched when --foreground was not requested', async () => {
  const result = await composeOpenWithInitialSnapshot({
    req: baseRequest(),
    sessionName: 'default',
    logPath: '/tmp/daemon.log',
    sessionStore: {} as never,
    openResponse: okOpenResponse,
  });

  expect(result).toBe(okOpenResponse);
  expect(dispatchSnapshotViaRuntime).not.toHaveBeenCalled();
});

test('attaches the initial snapshot by delegating to the existing snapshot runtime dispatch', async () => {
  dispatchSnapshotViaRuntime.mockResolvedValue({ ok: true, data: { nodes: [], truncated: false } });

  const req = baseRequest({ flags: { foreground: true }, positionals: ['xyz.blueskyweb.app'] });
  const result = await composeOpenWithInitialSnapshot({
    req,
    sessionName: 'default',
    logPath: '/tmp/daemon.log',
    sessionStore: {} as never,
    openResponse: okOpenResponse,
  });

  expect(dispatchSnapshotViaRuntime).toHaveBeenCalledWith({
    req: { ...req, command: 'snapshot', positionals: [] },
    sessionName: 'default',
    logPath: '/tmp/daemon.log',
    sessionStore: {},
  });
  expect(result).toEqual({
    ok: true,
    data: { session: 'default', snapshot: { nodes: [], truncated: false } },
  });
});

test('surfaces a snapshot-capture failure instead of the open success', async () => {
  const snapshotFailure: DaemonResponse = {
    ok: false,
    error: { code: 'COMMAND_FAILED', message: 'capture failed' },
  };
  dispatchSnapshotViaRuntime.mockResolvedValue(snapshotFailure);

  const result = await composeOpenWithInitialSnapshot({
    req: baseRequest({ flags: { foreground: true } }),
    sessionName: 'default',
    logPath: '/tmp/daemon.log',
    sessionStore: {} as never,
    openResponse: okOpenResponse,
  });

  expect(result).toBe(snapshotFailure);
});
