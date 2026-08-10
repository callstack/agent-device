import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { localRuntimeOwner } from '@agent-device/contracts/platform';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { createDurableCaptureResourceStore } from '../durable-capture-resource-store.ts';

const store = createDurableCaptureResourceStore({
  resourceKind: 'screen-recording',
  fileName: 'screen-recording.resource.json',
  displayName: 'Screen recording',
});

test('publishes typed resource records atomically with owner-only permissions', () => {
  const resourcePath = store.resolvePath(
    path.join(mkdtempForTestSync('capture-store-'), 'session'),
  );
  store.write(resourcePath, envelope('session'));

  expect(store.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { resourceKind: 'screen-recording', lifecycle: 'open' },
  });
  expect(fs.statSync(resourcePath).mode & 0o777).toBe(0o600);
  expect(fs.readdirSync(path.dirname(resourcePath))).toEqual(['screen-recording.resource.json']);
});

test('retains invalid evidence and never follows or replaces a symbolic link', () => {
  const root = mkdtempForTestSync('capture-store-link-');
  const outsidePath = path.join(root, 'outside.json');
  fs.writeFileSync(outsidePath, `${JSON.stringify(envelope('outside'))}\n`);
  const resourcePath = store.resolvePath(path.join(root, 'sessions', 'session'));
  fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
  fs.symlinkSync(outsidePath, resourcePath);

  expect(store.read(resourcePath)).toMatchObject({
    status: 'unreattachable',
    reason: 'descriptor-invalid',
  });
  expect(() => store.write(resourcePath, envelope('replacement'))).toThrow(/symbolic link/);
  expect(fs.lstatSync(resourcePath).isSymbolicLink()).toBe(true);
});

test('lists only this resource kind in deterministic session order', () => {
  const sessionsDir = mkdtempForTestSync('capture-store-list-');
  for (const name of ['zeta', 'alpha']) {
    const resourcePath = store.resolvePath(path.join(sessionsDir, name));
    store.write(resourcePath, envelope(name));
  }
  fs.writeFileSync(path.join(sessionsDir, 'unrelated.txt'), 'ignored');
  expect(store.list(sessionsDir)).toEqual([
    store.resolvePath(path.join(sessionsDir, 'alpha')),
    store.resolvePath(path.join(sessionsDir, 'zeta')),
  ]);
});

function envelope(sessionId: string) {
  return createDurableResourceEnvelope({
    resourceKind: 'screen-recording',
    sessionId,
    device: { id: 'emulator-5554', family: 'android', kind: 'emulator' },
    owner: localRuntimeOwner('android'),
    fence: { token: `fence-${sessionId}`, generation: 1 },
    lifecycle: 'open',
    descriptor: { version: 1, body: {} },
  });
}
