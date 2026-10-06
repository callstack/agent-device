// The pure hint formatter in src/daemon-client/daemon-client-timeout.ts: what a timed-out request
// tells the caller to do next. daemon-client-timeout-route.test.ts covers the same route at its
// production seam, where the liveness-gated recovery is decided; these assertions only fix wording.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { resolveRequestTimeoutHint } from '../daemon-client-timeout.ts';

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
    'Retry with --debug and check daemon diagnostics logs. The timed-out press request was canceled; the daemon was kept alive so the session can still be closed or inspected.',
  );
  assert.equal(
    resolveRequestTimeoutHint({
      remote: false,
      resetDaemon: false,
      command: 'snapshot',
      applePlatformDeclared: true,
    }),
    'Retry with --debug and check daemon diagnostics logs. The timed-out snapshot request was canceled; the daemon was kept alive so the session can still be closed or inspected. If this was the first Apple-platform snapshot on the device, run agent-device prepare ios-runner with the same --platform before snapshot/test so runner startup is handled explicitly.',
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
    'Retry with --debug and check daemon diagnostics logs. The timed-out snapshot request was canceled; the daemon was kept alive so the session can still be closed or inspected.',
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
      'Retry with --debug and check daemon diagnostics logs. The daemon did not answer the liveness probe and was reset after the timeout.',
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
    'Retry with --debug and verify the remote daemon URL, auth token, and remote host logs.',
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
    'Retry with --debug and check daemon diagnostics logs. The daemon did not answer the liveness probe and was reset after the timeout.',
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
    'Retry with --debug and verify the remote daemon URL, auth token, and remote host logs.',
  );
});
