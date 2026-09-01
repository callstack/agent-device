import { beforeEach, expect, test, vi } from 'vitest';

const dispatchSnapshotViaRuntime = vi.hoisted(() => vi.fn());

vi.mock('../../../snapshot-runtime.ts', () => ({ dispatchSnapshotViaRuntime }));

import { AppError } from '@agent-device/kernel/errors';
import type { DaemonRequest, DaemonResponse } from '../../../types.ts';
import {
  composeOpenWithInitialSnapshot,
  resolveForegroundOpenRequest,
} from '../session-open-foreground.ts';

const inspectFacts = vi.fn();
const bindDevice = vi.fn();

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
  dispatchSnapshotViaRuntime.mockReset();
  inspectFacts.mockReset();
  bindDevice.mockReset();
});

// --- resolveForegroundOpenRequest ---

test('leaves the request untouched when --foreground was not requested', async () => {
  const resolution = await resolveForegroundOpenRequest({
    req: baseRequest(),
    hasExistingSession: false,
  });

  expect(resolution).toEqual({ type: 'not-requested' });
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
});

test('keeps an explicit app and its target constraints for foreground composition on an existing session', async () => {
  const req = baseRequest({
    flags: {
      foreground: true,
      platform: 'ios',
      udid: 'configured-udid',
      iosSimulatorDeviceSet: '/custom/set',
    },
    positionals: ['com.example.demo'],
  });
  const resolution = await resolveForegroundOpenRequest({
    req,
    hasExistingSession: true,
  });

  expect(resolution).toEqual({ type: 'resolved', req });
});

test.each([
  ['udid', { udid: 'explicit-udid' }],
  ['device', { device: 'iPhone 16' }],
  ['udid and device', { udid: 'explicit-udid', device: 'iPhone 16' }],
])(
  'rejects --foreground with an explicit %s selector instead of silently overwriting it',
  async (_label, selectorFlags) => {
    const resolution = await resolveForegroundOpenRequest({
      req: baseRequest({ flags: { foreground: true, ...selectorFlags } }),
      hasExistingSession: false,
    });

    expect(resolution.type).toBe('response');
    if (resolution.type === 'response') {
      expect(resolution.response.ok).toBe(false);
      if (!resolution.response.ok) {
        expect(resolution.response.error.code).toBe('INVALID_ARGS');
        expect(resolution.response.error.message).toMatch(/resolves the device itself/);
      }
    }
  },
);

test('rejects --foreground with a non-iOS platform selector', async () => {
  const resolution = await resolveForegroundOpenRequest({
    req: baseRequest({ flags: { foreground: true, platform: 'android' } }),
    hasExistingSession: false,
  });

  expect(resolution.type).toBe('response');
  if (resolution.type === 'response') {
    expect(resolution.response.ok).toBe(false);
    if (!resolution.response.ok) {
      expect(resolution.response.error.code).toBe('INVALID_ARGS');
      expect(resolution.response.error.message).toMatch(/only supports --platform ios/);
    }
  }
});

test('a bare iOS foreground request reaches the admitted lifecycle target resolver unchanged', async () => {
  const resolution = await resolveForegroundOpenRequest({
    req: baseRequest({ flags: { foreground: true, platform: 'ios' } }),
    hasExistingSession: false,
  });

  expect(resolution).toEqual({
    type: 'resolved',
    req: baseRequest({
      flags: {
        foreground: true,
        platform: 'ios',
      },
    }),
  });
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
    inspectFacts,
    bindDevice,
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
    inspectFacts,
    bindDevice,
  });

  expect(result).toBe(okOpenResponse);
  expect(dispatchSnapshotViaRuntime).not.toHaveBeenCalled();
});

test('attaches the initial INTERACTIVE snapshot by delegating to the existing snapshot runtime dispatch', async () => {
  dispatchSnapshotViaRuntime.mockResolvedValue({ ok: true, data: { nodes: [], truncated: false } });

  const req = baseRequest({ flags: { foreground: true }, positionals: ['xyz.blueskyweb.app'] });
  const result = await composeOpenWithInitialSnapshot({
    req,
    sessionName: 'default',
    logPath: '/tmp/daemon.log',
    sessionStore: {} as never,
    openResponse: okOpenResponse,
    inspectFacts,
    bindDevice,
  });

  // #1670 P1: the composed dispatch must BE the `snapshot -i` path — the CLI
  // maps `-i` to snapshotInteractiveOnly, the key the snapshot runtime reads.
  expect(dispatchSnapshotViaRuntime).toHaveBeenCalledWith({
    req: {
      ...req,
      command: 'snapshot',
      positionals: [],
      flags: { ...req.flags, snapshotInteractiveOnly: true },
    },
    sessionName: 'default',
    logPath: '/tmp/daemon.log',
    sessionStore: {},
    inspectFacts,
    bindDevice,
  });
  expect(result).toEqual({
    ok: true,
    data: { session: 'default', snapshot: { nodes: [], truncated: false } },
  });
});

test('a snapshot-capture failure never masks the successful open', async () => {
  // #1670 P1: the session EXISTS once open succeeded — returning the capture
  // error made a retry of `open --foreground` fail with "close the current
  // session first". The response must stay ok, disclose the capture failure,
  // and tell the caller the session is usable.
  const snapshotFailure: DaemonResponse = {
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message: 'capture failed',
      hint: 'Retry with --debug and inspect diagnostics log for details.',
      diagnosticId: 'diag-1',
      logPath: '/tmp/requests/req-1.ndjson',
      details: { reason: 'runner_unavailable' },
    },
  };
  dispatchSnapshotViaRuntime.mockResolvedValue(snapshotFailure);

  const result = await composeOpenWithInitialSnapshot({
    req: baseRequest({ flags: { foreground: true } }),
    sessionName: 'default',
    logPath: '/tmp/daemon.log',
    sessionStore: {} as never,
    openResponse: { ok: true, data: { session: 'default', warnings: ['pre-existing warning'] } },
    inspectFacts,
    bindDevice,
  });

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.data?.session).toBe('default');
    expect(result.data?.snapshot).toBeUndefined();
    // The FULL error shape survives — hint/details/diagnosticId/logPath, not
    // a code+message truncation.
    expect(result.data?.initialSnapshotError).toEqual({
      code: 'COMMAND_FAILED',
      message: 'capture failed',
      hint: 'Retry with --debug and inspect diagnostics log for details.',
      diagnosticId: 'diag-1',
      logPath: '/tmp/requests/req-1.ndjson',
      details: { reason: 'runner_unavailable' },
    });
    expect(result.data?.warnings).toEqual([
      'pre-existing warning',
      'The session is open, but the initial interactive snapshot failed (COMMAND_FAILED: capture failed). Run: agent-device snapshot -i',
    ]);
  }
});

test('a THROWN snapshot-capture failure never masks the successful open either', async () => {
  // The runtime dispatch rethrows ordinary capture/runner exceptions; an
  // escaped rejection would fail the whole open after the session was created
  // and wedge the retry on the existing session — same contract as a returned
  // { ok: false }: ok response, disclosed failure, usable session.
  dispatchSnapshotViaRuntime.mockRejectedValue(
    new AppError('COMMAND_FAILED', 'runner crashed mid-capture', {
      diagnosticId: 'diag-thrown-1',
    }),
  );

  const result = await composeOpenWithInitialSnapshot({
    req: baseRequest({ flags: { foreground: true } }),
    sessionName: 'default',
    logPath: '/tmp/daemon.log',
    sessionStore: {} as never,
    openResponse: { ok: true, data: { session: 'default' } },
    inspectFacts,
    bindDevice,
  });

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.data?.session).toBe('default');
    expect(result.data?.snapshot).toBeUndefined();
    const error = result.data?.initialSnapshotError as Record<string, unknown>;
    expect(error?.code).toBe('COMMAND_FAILED');
    expect(error?.message).toBe('runner crashed mid-capture');
    expect(error?.diagnosticId).toBe('diag-thrown-1');
    expect(result.data?.warnings).toEqual([
      'The session is open, but the initial interactive snapshot failed (COMMAND_FAILED: runner crashed mid-capture). Run: agent-device snapshot -i',
    ]);
  }
});
