import { afterEach, expect, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import {
  requireManagedSessionArtifactPath,
  resolveSessionDir,
  resolveSessionFallbackScreenshotPath,
  resolveSessionScreenshotNamePrefix,
  resolveSessionScreenshotStagingDir,
  resolveSessionScreenshotsDir,
} from './session-artifact-paths.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit';

test('resolveSessionDir keeps every session dir beneath the sessions dir', () => {
  const sessionsDir = path.join(
    mkdtempForTestSync('agent-device-tests'),
    'agent-device-tests',
    'sessions',
  );
  assert.equal(resolveSessionDir(sessionsDir, 'a/b:c d'), path.join(sessionsDir, 'a_b_c_d'));
  // `.` and `..` survive `safeSessionName` unchanged, so without an explicit
  // refusal `path.join` resolves them to the sessions dir itself and its parent
  // (the daemon state dir): a remote caller's `--session ..` would then land
  // app.log / runner.log / requests/*.ndjson outside the sessions tree.
  for (const name of ['.', '..', '']) {
    assert.throws(
      () => resolveSessionDir(sessionsDir, name),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        /session name/i.test(error.message),
      `expected resolveSessionDir(${JSON.stringify(name)}) to reject`,
    );
  }
});

test('the session screenshot paths sit in one screenshots dir with distinct names', () => {
  const sessionDir = path.join(
    mkdtempForTestSync('agent-device-screenshot-paths-'),
    'sessions',
    'one',
  );
  const screenshotsDir = resolveSessionScreenshotsDir(sessionDir);

  assert.equal(screenshotsDir, path.join(sessionDir, 'screenshots'));
  // Re-resolving is pure: the same request id predicts the same name prefix every time.
  assert.equal(
    resolveSessionScreenshotNamePrefix('req-1'),
    resolveSessionScreenshotNamePrefix('req-1'),
  );
  assert.equal(resolveSessionScreenshotNamePrefix('req-1'), 'req-1');
  // A request id carries characters a file name must not (`req:<seed>:<pid>:…`), and a
  // capture without a request id still owns a stable prefix.
  assert.equal(resolveSessionScreenshotNamePrefix('req:abc:1:2:x'), 'req_abc_1_2_x');
  assert.equal(resolveSessionScreenshotNamePrefix(undefined), 'screenshot');
  assert.equal(resolveSessionScreenshotNamePrefix(''), 'screenshot');
  assert.equal(
    resolveSessionFallbackScreenshotPath(sessionDir),
    path.join(screenshotsDir, 'snapshot-fallback.png'),
  );
  assert.equal(
    resolveSessionScreenshotStagingDir(sessionDir),
    path.join(screenshotsDir, 'crop-staging'),
  );
  // A fallback capture writes its own name, so it never lands on a minted capture file.
  assert.notEqual(
    path.basename(resolveSessionFallbackScreenshotPath(sessionDir)),
    `${resolveSessionScreenshotNamePrefix(undefined)}.png`,
  );
});

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('accepts the named artifact below the sessions root', () => {
  const root = temporaryRoot();
  const sessionsDir = path.join(root, 'sessions');
  const pathname = path.join(sessionsDir, 'one', 'app.log');
  fs.mkdirSync(path.dirname(pathname), { recursive: true });

  expect(
    requireManagedSessionArtifactPath({
      sessionsDir,
      pathname,
      basename: 'app.log',
      label: 'App-log output',
    }),
  ).toBe(path.join(fs.realpathSync.native(path.dirname(pathname)), 'app.log'));
});

test('rejects a symlinked parent that escapes the sessions root', () => {
  const root = temporaryRoot();
  const sessionsDir = path.join(root, 'sessions');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(sessionsDir);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(sessionsDir, 'linked'));

  expect(() =>
    requireManagedSessionArtifactPath({
      sessionsDir,
      pathname: path.join(sessionsDir, 'linked', 'app-log.pid'),
      basename: 'app-log.pid',
      label: 'App-log process marker',
    }),
  ).toThrow('App-log process marker resolves outside the daemon-owned sessions directory');
});

test('returns the verified real parent rather than a symlink alias', () => {
  const root = temporaryRoot();
  const sessionsDir = path.join(root, 'sessions');
  const realSession = path.join(sessionsDir, 'real');
  const linkedSession = path.join(sessionsDir, 'linked');
  fs.mkdirSync(realSession, { recursive: true });
  fs.symlinkSync(realSession, linkedSession);

  expect(
    requireManagedSessionArtifactPath({
      sessionsDir,
      pathname: path.join(linkedSession, 'app-log.pid'),
      basename: 'app-log.pid',
      label: 'App-log process marker',
    }),
  ).toBe(path.join(fs.realpathSync.native(realSession), 'app-log.pid'));
});

test('accepts different lexical aliases for the same verified sessions root', () => {
  const root = temporaryRoot();
  const realSessionsDir = path.join(root, 'real-sessions');
  const linkedSessionsDir = path.join(root, 'linked-sessions');
  const realSession = path.join(realSessionsDir, 'one');
  fs.mkdirSync(realSession, { recursive: true });
  fs.symlinkSync(realSessionsDir, linkedSessionsDir);

  expect(
    requireManagedSessionArtifactPath({
      sessionsDir: linkedSessionsDir,
      pathname: path.join(realSession, 'app-log.pid'),
      basename: 'app-log.pid',
      label: 'App-log process marker',
    }),
  ).toBe(path.join(fs.realpathSync.native(realSession), 'app-log.pid'));
});

function temporaryRoot(): string {
  const root = mkdtempForTestSync('agent-device-session-artifact-');
  roots.push(root);
  return root;
}
