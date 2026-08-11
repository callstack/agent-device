import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { localRuntimeOwner } from '@agent-device/contracts/platform';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { deviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { createAppLogAdmissionLedger } from '../app-log-admission-ledger.ts';
import { createNextAppLogFence } from '../app-log-start-preflight.ts';
import { appLogResourceStore } from '../app-log-resource-store.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'cross-session-device',
  name: 'Pixel',
  kind: 'emulator',
};

test('nonterminal record from an old session blocks replacement on the same device', () => {
  const ledger = createAppLogAdmissionLedger();
  const sessionStore = makeSessionStore('app-log-start-preflight-cross-session-');
  const oldResourcePath = appLogResourceStore.resolvePath(
    sessionStore.resolveSessionDir('old-session'),
  );
  appLogResourceStore.write(
    oldResourcePath,
    createDurableResourceEnvelope({
      resourceKind: 'app-log',
      sessionId: 'old-session',
      device: { id: device.id, family: 'android', kind: 'emulator' },
      owner: localRuntimeOwner('android'),
      fence: { token: 'old', generation: 1 },
      lifecycle: 'open',
      metadata: { phase: 'cleanup-pending' },
      descriptor: { version: 1, body: {} },
    }),
  );
  const newResourcePath = appLogResourceStore.resolvePath(
    sessionStore.resolveSessionDir('replacement-session'),
  );

  expect(() => createNextAppLogFence({ ledger, resourcePath: newResourcePath, device })).toThrow(
    /this device/,
  );
});

test('an undecodable manifest or retained legacy marker blocks all replacement starts', () => {
  const ledger = createAppLogAdmissionLedger({ markerExists: () => true });
  const sessionStore = makeSessionStore('app-log-start-preflight-global-');
  const resourcePath = appLogResourceStore.resolvePath(
    sessionStore.resolveSessionDir('new-session'),
  );
  const corruptPath = appLogResourceStore.resolvePath(
    sessionStore.resolveSessionDir('corrupt-session'),
  );
  fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
  fs.writeFileSync(corruptPath, '{');

  expect(() => createNextAppLogFence({ ledger, resourcePath, device })).toThrow(/unreattachable/);

  fs.rmSync(corruptPath);
  ledger.retainLegacyMarkers([
    { markerPath: '/sessions/legacy/app-log.pid', device: deviceIdentity(device) },
  ]);
  expect(() => createNextAppLogFence({ ledger, resourcePath, device })).toThrow(
    /legacy app-log marker/,
  );
});

test('a symlinked manifest blocks replacement globally without touching its external target', () => {
  const ledger = createAppLogAdmissionLedger();
  const sessionStore = makeSessionStore('app-log-start-preflight-symlink-');
  const sessionsDir = path.dirname(sessionStore.resolveSessionDir('unused'));
  const outsidePath = path.join(path.dirname(sessionsDir), 'outside.json');
  const outsideBody = `${JSON.stringify(
    createDurableResourceEnvelope({
      resourceKind: 'app-log',
      sessionId: 'outside',
      device: { id: 'other-device', family: 'android', kind: 'emulator' },
      owner: localRuntimeOwner('android'),
      fence: { token: 'outside', generation: 1 },
      lifecycle: 'completed',
      descriptor: { version: 1, body: {} },
    }),
  )}\n`;
  fs.writeFileSync(outsidePath, outsideBody);
  const symlinkPath = appLogResourceStore.resolvePath(
    sessionStore.resolveSessionDir('symlink-session'),
  );
  fs.mkdirSync(path.dirname(symlinkPath), { recursive: true });
  fs.symlinkSync(outsidePath, symlinkPath);
  const replacementPath = appLogResourceStore.resolvePath(
    sessionStore.resolveSessionDir('replacement-session'),
  );

  expect(() => createNextAppLogFence({ ledger, resourcePath: replacementPath, device })).toThrow(
    /unreattachable/,
  );
  expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(outsidePath, 'utf8')).toBe(outsideBody);
});
