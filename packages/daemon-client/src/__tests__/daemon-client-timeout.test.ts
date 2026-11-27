// The pure hint formatter in packages/daemon-client/src/daemon-client-timeout.ts: what a timed-out request
// tells the caller to do next. daemon-client-timeout-route.test.ts covers the same route at its
// production seam, where the liveness-gated recovery is decided; these assertions only fix wording.

import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { handleRequestTimeout, resolveRequestTimeoutHint } from '../daemon-client-timeout.ts';

const { emitted } = vi.hoisted(() => ({ emitted: [] as Array<Record<string, unknown>> }));
vi.mock('@agent-device/host-kit/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/diagnostics')>();
  return {
    ...actual,
    emitDiagnostic: (event: Parameters<typeof actual.emitDiagnostic>[0]) => {
      emitted.push({ phase: event.phase, ...(event.data as Record<string, unknown>) });
    },
  };
});

test('request timeout hint names an Apple runner only on a declared Apple platform', () => {
  // The hint used to derive its Apple claim partly from a host-wide `pkill` sweep that counted
  // whatever it terminated (#1751). That sweep ended every session on the host and is gone
  // (#3177), so the only Apple evidence this route has left is a selector that says so outright.
  assert.equal(
    resolveRequestTimeoutHint({
      remote: false,
      resetDaemon: false,
      command: 'press',
      applePlatformDeclared: true,
    }),
    'The timed-out press request was canceled; the daemon was kept alive so the session can still be closed or inspected. Read the request log for the timed-out step.',
  );
  assert.equal(
    resolveRequestTimeoutHint({
      remote: false,
      resetDaemon: false,
      command: 'snapshot',
      applePlatformDeclared: true,
    }),
    'The timed-out snapshot request was canceled; the daemon was kept alive so the session can still be closed or inspected. Read the request log for the timed-out step. If this was the first Apple-platform snapshot on the device, run agent-device prepare ios-runner with the same --platform before snapshot/test so runner startup is handled explicitly.',
  );

  // An undeclared or declared non-Apple platform names no Apple runner in any branch, and the
  // Apple-only prepare follow-up drops entirely.
  assert.equal(
    resolveRequestTimeoutHint({
      remote: false,
      resetDaemon: false,
      command: 'snapshot',
      applePlatformDeclared: false,
    }),
    'The timed-out snapshot request was canceled; the daemon was kept alive so the session can still be closed or inspected. Read the request log for the timed-out step.',
  );

  // A reset is now reported as what it was decided from: an unanswered liveness probe. The reset
  // SIGKILLs the daemon pid only, so the hint claims nothing about runner children it cannot
  // prove stopped — and a declared Apple platform changes the reset wording not at all.
  for (const applePlatformDeclared of [true, false]) {
    assert.equal(
      resolveRequestTimeoutHint({
        remote: false,
        resetDaemon: true,
        command: 'open',
        applePlatformDeclared,
      }),
      'The daemon did not answer the liveness probes and was reset after the timeout. Read the request log for the timed-out step.',
    );
  }

  // Remote requests were never Apple-specific and stay evidence-independent.
  assert.equal(
    resolveRequestTimeoutHint({
      remote: true,
      resetDaemon: false,
      command: 'press',
      applePlatformDeclared: false,
    }),
    'Verify the remote daemon URL, auth token, and remote host logs.',
  );
});

test('a remote timeout clears the URL and token once the response started or /health answered', () => {
  const started =
    'The remote daemon already started answering this request, so its URL and auth token are not the cause.';
  const reachable =
    'The remote daemon still answers /health, so its URL and auth token are not the cause.';
  // The CLI prints "Run snapshot to check the screen before you retry." first, because the open
  // may have launched the app, so the retry is stated as safe whatever that check shows.
  const retry =
    'The daemon canceled this open, so running it again is safe even if the app launched.';
  // A streamed first Apple open that started responding before timing out (#5004).
  assert.equal(
    resolveRequestTimeoutHint({
      remote: true,
      remoteResponseStarted: true,
      resetDaemon: false,
      command: 'open',
      applePlatformDeclared: true,
    }),
    `${started} A first Apple open can outlast the request window while the host builds and starts the XCTest runner. ${retry} For a longer startup window, run agent-device prepare ios-runner with the same --platform first.`,
  );
  assert.equal(
    resolveRequestTimeoutHint({
      remote: true,
      remoteResponseStarted: true,
      resetDaemon: false,
      command: 'open',
      applePlatformDeclared: false,
    }),
    `${started} ${retry}`,
  );
  // If both flags are set, the started response is the stronger proof and chooses the lead wording.
  assert.equal(
    resolveRequestTimeoutHint({
      remote: true,
      remoteResponseStarted: true,
      remoteHealthAnswered: true,
      resetDaemon: false,
      command: 'press',
      applePlatformDeclared: true,
    }),
    `${started} Read the remote host logs for the timed-out press step.`,
  );
  // A non-streaming caller whose `/health` probe answered gets the same recovery guidance.
  assert.equal(
    resolveRequestTimeoutHint({
      remote: true,
      remoteResponseStarted: false,
      remoteHealthAnswered: true,
      resetDaemon: false,
      command: 'open',
      applePlatformDeclared: true,
    }),
    `${reachable} A first Apple open can outlast the request window while the host builds and starts the XCTest runner. ${retry} For a longer startup window, run agent-device prepare ios-runner with the same --platform first.`,
  );
  assert.equal(
    resolveRequestTimeoutHint({
      remote: true,
      remoteHealthAnswered: true,
      resetDaemon: false,
      command: 'open',
      applePlatformDeclared: false,
    }),
    `${reachable} ${retry}`,
  );
  // Another command may have acted before the window closed, so no retry is promised.
  assert.equal(
    resolveRequestTimeoutHint({
      remote: true,
      remoteHealthAnswered: true,
      resetDaemon: false,
      command: undefined,
      applePlatformDeclared: true,
    }),
    `${reachable} Read the remote host logs for the timed-out request step.`,
  );
  // The error's details are capped when normalized, and a cut hint loses its last step.
  for (const applePlatformDeclared of [true, false]) {
    for (const remoteResponseStarted of [true, false]) {
      const hint = resolveRequestTimeoutHint({
        remote: true,
        remoteResponseStarted,
        remoteHealthAnswered: !remoteResponseStarted,
        resetDaemon: false,
        command: 'open',
        applePlatformDeclared,
      });
      assert.equal(
        normalizeError(new AppError('COMMAND_FAILED', 'timed out', { hint })).hint,
        hint,
      );
    }
  }
  // The closest negative: neither a started response nor a healthy daemon keeps the old hint.
  assert.equal(
    resolveRequestTimeoutHint({
      remote: true,
      remoteResponseStarted: false,
      remoteHealthAnswered: false,
      resetDaemon: false,
      command: 'open',
      applePlatformDeclared: true,
    }),
    'Verify the remote daemon URL, auth token, and remote host logs.',
  );
});

test('a timed-out record stop on a surviving daemon names the retry that returns the export', () => {
  // A remote client never touches the daemon's host, so its daemon survives by construction.
  assert.equal(
    resolveRequestTimeoutHint({
      remote: true,
      resetDaemon: false,
      command: 'record',
      applePlatformDeclared: false,
      action: 'stop',
      session: 'recording',
    }),
    'The remote daemon may still be exporting the recording. Run agent-device record stop --session recording again to wait for that export and receive the completed recording.',
  );
  assert.equal(
    resolveRequestTimeoutHint({
      remote: true,
      resetDaemon: false,
      command: 'record',
      applePlatformDeclared: false,
      action: 'stop',
    }),
    'The remote daemon may still be exporting the recording. Run agent-device record stop again to wait for that export and receive the completed recording.',
  );
  // A LOCAL daemon preserved across the timeout (#3199 declares `record` preserve-daemon) may
  // still be exporting too, so it gets the same retry instead of the generic kept-alive wording.
  assert.equal(
    resolveRequestTimeoutHint({
      remote: false,
      resetDaemon: false,
      command: 'record',
      applePlatformDeclared: false,
      action: 'stop',
      session: 'recording',
    }),
    'The daemon may still be exporting the recording. Run agent-device record stop --session recording again to wait for that export and receive the completed recording.',
  );
  // A daemon the probe proved unresponsive was reset, and a reset daemon is no longer exporting:
  // no keep-exporting promise is made, and the wording says what happened to it instead.
  assert.equal(
    resolveRequestTimeoutHint({
      remote: false,
      resetDaemon: true,
      command: 'record',
      applePlatformDeclared: false,
      action: 'stop',
      session: 'recording',
    }),
    'The daemon did not answer the liveness probes and was reset after the timeout. Read the request log for the timed-out step.',
  );
  // `record start` runs no export, so it keeps the generic remote wording.
  assert.equal(
    resolveRequestTimeoutHint({
      remote: true,
      resetDaemon: false,
      command: 'record',
      applePlatformDeclared: false,
      action: 'start',
      session: 'recording',
    }),
    'Verify the remote daemon URL, auth token, and remote host logs.',
  );
});

test('a checked request timeout keeps the endpoint out of its diagnostic', async () => {
  const timeout = async (checkedRpc: boolean) => {
    emitted.length = 0;
    await handleRequestTimeout({
      info: {
        token: 't',
        pid: 0,
        baseUrl: 'https://user:secret@remote.example.test/private',
        ...(checkedRpc ? { checkedRpc: true as const } : {}),
      },
      statePaths: resolveDaemonPaths(mkdtempForTestSync('checked-timeout-')),
      remote: true,
      retireUnresponsive: false,
      timeoutMs: 1_000,
      requestId: 'req-1',
      command: 'session',
      platform: undefined,
      requestSent: true,
      responseStarted: true,
      readRemoteHealth: async () => ({ reachable: false }),
    });
    return emitted.find((event) => event.phase === 'daemon_request_timeout');
  };

  assert.equal((await timeout(true))?.daemonBaseUrl, undefined);
  assert.ok((await timeout(false))?.daemonBaseUrl, 'the legacy diagnostic keeps its endpoint');
});
