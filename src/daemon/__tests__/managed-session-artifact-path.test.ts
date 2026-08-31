import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { requireManagedSessionArtifactPath } from '../managed-session-artifact-path.ts';

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-session-artifact-'));
  roots.push(root);
  return root;
}
