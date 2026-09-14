// The pure hint formatter in src/daemon-client/daemon-client-timeout.ts: what a timed-out request
// tells the caller to do next. daemon-client-timeout-route.test.ts covers the same route at its
// production seam, where cleanup eligibility is decided; these assertions only fix the wording.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { resolveRequestTimeoutHint } from '../daemon-client-timeout.ts';

test('request timeout hint only names Apple runner cleanup on actual evidence', () => {
  // Before this change, handleRequestTimeout emitted Apple-specific hint
  // wording for EVERY local timeout, regardless of the request's
  // --platform. That was misleading for Android/web/Harmony sessions, which
  // never had any Apple runner work to abort.
  //
  // The fix is evidence-based, not platform-guess-based:
  // `appleCleanupEvidence` is true only when the request declared an
  // AFFIRMATIVELY Apple platform (apple/ios/macos) or the pkill cleanup
  // itself terminated a matching process — never from an undeclared or
  // declared-non-Apple platform alone. (Why not trust the declared platform
  // directly: it is not authoritative for session-bound execution — see
  // `handleRequestTimeout`'s comment and the production-seam coverage in
  // daemon-client-timeout-route.test.ts for the cleanup-eligibility half of
  // this contract that this pure formatter test cannot prove.)

  // appleCleanupEvidence: true keeps the exact historical wording — nothing
  // regresses for the true-Apple case.
  assert.equal(
    resolveRequestTimeoutHint({
      remote: false,
      resetDaemon: false,
      command: 'press',
      appleCleanupEvidence: true,
    }),
    'Retry with --debug and check daemon diagnostics logs. The timed-out press request was canceled and Apple runner work was aborted when detected; the daemon was kept alive so the session can still be closed or inspected.',
  );
  assert.equal(
    resolveRequestTimeoutHint({
      remote: false,
      resetDaemon: true,
      command: 'open',
      appleCleanupEvidence: true,
    }),
    'Retry with --debug and check daemon diagnostics logs. Timed-out Apple runner xcodebuild processes were terminated when detected.',
  );
  assert.equal(
    resolveRequestTimeoutHint({
      remote: false,
      resetDaemon: false,
      command: 'snapshot',
      appleCleanupEvidence: true,
    }),
    'Retry with --debug and check daemon diagnostics logs. The timed-out snapshot request was canceled and Apple runner work was aborted when detected; the daemon was kept alive so the session can still be closed or inspected. If this was the first Apple-platform snapshot on the device, run agent-device prepare ios-runner with the same --platform before snapshot/test so runner startup is handled explicitly.',
  );

  // appleCleanupEvidence: false — no Apple-runner claim in any branch, and
  // the Apple-only iOS-prepare follow-up drops entirely. This is the
  // motivating fix: it fires equally whether the platform was declared
  // non-Apple OR left undeclared (the common session-bound case), because
  // neither is Apple evidence on its own.
  assert.equal(
    resolveRequestTimeoutHint({
      remote: false,
      resetDaemon: false,
      command: 'press',
      appleCleanupEvidence: false,
    }),
    'Retry with --debug and check daemon diagnostics logs. The timed-out press request was canceled; the daemon was kept alive so the session can still be closed or inspected.',
  );
  assert.equal(
    resolveRequestTimeoutHint({
      remote: false,
      resetDaemon: true,
      command: 'open',
      appleCleanupEvidence: false,
    }),
    'Retry with --debug and check daemon diagnostics logs. The daemon was reset after the timeout.',
  );
  assert.equal(
    resolveRequestTimeoutHint({
      remote: false,
      resetDaemon: false,
      command: 'snapshot',
      appleCleanupEvidence: false,
    }),
    'Retry with --debug and check daemon diagnostics logs. The timed-out snapshot request was canceled; the daemon was kept alive so the session can still be closed or inspected.',
  );

  // Remote requests were never Apple-specific and stay evidence-independent.
  assert.equal(
    resolveRequestTimeoutHint({
      remote: true,
      resetDaemon: false,
      command: 'press',
      appleCleanupEvidence: false,
    }),
    'Retry with --debug and verify the remote daemon URL, auth token, and remote host logs.',
  );
});

test('a timed-out remote recording names the retry that returns the export', () => {
  assert.equal(
    resolveRequestTimeoutHint({
      remote: true,
      resetDaemon: false,
      command: 'record',
      appleCleanupEvidence: false,
      action: 'stop',
      session: 'recording',
    }),
    'The remote daemon is still exporting the recording. Run agent-device record stop --session recording again to wait for that export and receive the completed recording.',
  );
  assert.equal(
    resolveRequestTimeoutHint({
      remote: true,
      resetDaemon: false,
      command: 'record',
      appleCleanupEvidence: false,
      action: 'stop',
    }),
    'The remote daemon is still exporting the recording. Run agent-device record stop again to wait for that export and receive the completed recording.',
  );
  // A local timeout resets the daemon mid-export, so no keep-exporting promise is made.
  assert.equal(
    resolveRequestTimeoutHint({
      remote: false,
      resetDaemon: true,
      command: 'record',
      appleCleanupEvidence: false,
      action: 'stop',
      session: 'recording',
    }),
    'Retry with --debug and check daemon diagnostics logs. The daemon was reset after the timeout.',
  );
  // `record start` runs no export, so it keeps the generic remote wording.
  assert.equal(
    resolveRequestTimeoutHint({
      remote: true,
      resetDaemon: false,
      command: 'record',
      appleCleanupEvidence: false,
      action: 'start',
      session: 'recording',
    }),
    'Retry with --debug and verify the remote daemon URL, auth token, and remote host logs.',
  );
});
