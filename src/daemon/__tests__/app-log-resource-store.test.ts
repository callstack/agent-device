import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { appLogResourceStore } from '../app-log-resource-store.ts';

test('app-log resource records publish atomically with owner-only permissions', () => {
  const resourcePath = appLogResourceStore.resolvePath(
    path.join(mkdtempForTestSync('app-log-record-'), 'session'),
  );
  appLogResourceStore.write(resourcePath, envelope('session'));

  expect(appLogResourceStore.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { resourceKind: 'app-log', lifecycle: 'open' },
  });
  expect(fs.statSync(resourcePath).mode & 0o777).toBe(0o600);
  expect(fs.readdirSync(path.dirname(resourcePath))).toEqual(['app-log.resource.json']);
});

test.each([
  ['invalid JSON', '{'],
  ['unsupported schema', JSON.stringify({ ...envelope('session'), envelopeVersion: 999 })],
] as const)('app-log resource reader classifies and retains %s', (_name, body) => {
  const resourcePath = appLogResourceStore.resolvePath(
    path.join(mkdtempForTestSync('app-log-unreattachable-'), 'session'),
  );
  fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
  fs.writeFileSync(resourcePath, body);

  expect(appLogResourceStore.read(resourcePath).status).toBe('unreattachable');
  expect(fs.readFileSync(resourcePath, 'utf8')).toBe(body);
});

test('malformed app-log records preserve the underlying decoder message', () => {
  const resourcePath = appLogResourceStore.resolvePath(
    path.join(mkdtempForTestSync('app-log-malformed-message-'), 'session'),
  );
  fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
  fs.writeFileSync(resourcePath, '{');
  let expectedMessage = '';
  try {
    JSON.parse('{');
  } catch (error) {
    expectedMessage = error instanceof Error ? error.message : '';
  }

  expect(appLogResourceStore.read(resourcePath)).toMatchObject({
    status: 'unreattachable',
    message: expectedMessage,
  });
});

test('app-log resource listing is deterministic and ignores unrelated artifacts', () => {
  const sessionsDir = mkdtempForTestSync('app-log-record-list-');
  for (const sessionName of ['zeta', 'alpha']) {
    const resourcePath = appLogResourceStore.resolvePath(path.join(sessionsDir, sessionName));
    appLogResourceStore.write(resourcePath, envelope(sessionName));
  }
  fs.writeFileSync(path.join(sessionsDir, 'unrelated.txt'), 'ignored');
  expect(appLogResourceStore.list(sessionsDir)).toEqual([
    appLogResourceStore.resolvePath(path.join(sessionsDir, 'alpha')),
    appLogResourceStore.resolvePath(path.join(sessionsDir, 'zeta')),
  ]);
});

test('resource symlinks are retained as unreattachable evidence and never replaced on write', () => {
  const root = mkdtempForTestSync('app-log-record-symlink-');
  const outsidePath = path.join(root, 'outside.json');
  const outsideBody = `${JSON.stringify(envelope('outside'))}\n`;
  fs.writeFileSync(outsidePath, outsideBody);
  const resourcePath = appLogResourceStore.resolvePath(path.join(root, 'sessions', 'session'));
  fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
  fs.symlinkSync(outsidePath, resourcePath);

  expect(appLogResourceStore.read(resourcePath)).toMatchObject({
    status: 'unreattachable',
    reason: 'descriptor-invalid',
    message: expect.stringMatching(/regular file/),
  });
  expect(() => appLogResourceStore.write(resourcePath, envelope('replacement'))).toThrow(
    /symbolic link/,
  );
  expect(fs.lstatSync(resourcePath).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(outsidePath, 'utf8')).toBe(outsideBody);
});

function envelope(sessionId: string) {
  return createDurableResourceEnvelope({
    resourceKind: 'app-log',
    sessionId,
    device: { id: 'emulator-5554', family: 'android', kind: 'emulator' },
    owner: localRuntimeOwner('android'),
    fence: { token: `fence-${sessionId}`, generation: 1 },
    lifecycle: 'open',
    descriptor: { version: 1, body: {} },
  });
}
