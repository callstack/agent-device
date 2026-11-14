import { test, expect } from 'vitest';
import { daemonPlatformServicesFixture } from '../../../../__tests__/support/platform-services-fixture.ts';
import { makeSessionStore } from '../../../../__tests__/support/store-factory.ts';
import { makeSession } from '../../../../__tests__/support/handlers/session-test-harness.ts';
import { handleSessionInventoryCommands } from '../inventory.ts';
import type { DaemonRequest } from '../../../../core/daemon-request.ts';
import { bindTestCommandHost, createTestHostEnvironment } from '@agent-device/test-kit';
import type { SessionStore } from '../../../../core/session-store.ts';

bindTestCommandHost();

// #4525: a remote CI integration records which OS a capture ran on from the command result alone,
// so `session list` reports the device kind beside the model and OS version its host discovery read.
test('session_list reports the session device kind, model and OS version', async () => {
  const sessionStore = makeSessionStore('agent-device-inventory-session-device-');
  sessionStore.publish(
    'ios-1',
    makeSession('ios-1', {
      platform: 'apple',
      appleOs: 'ios',
      id: 'SIM-001',
      name: 'iPhone 17',
      kind: 'simulator',
      model: 'iPhone 17',
      osVersion: '27.0',
      booted: true,
    }),
  );
  sessionStore.publish(
    'android-1',
    makeSession('android-1', {
      platform: 'android',
      id: 'emulator-5554',
      name: 'pixel-9',
      kind: 'emulator',
      model: 'sdk_gphone64_arm64',
      osVersion: '16',
      booted: true,
    }),
  );
  // A host that read no description (for example a stopped AVD) states nothing about the OS.
  sessionStore.publish(
    'android-stopped',
    makeSession('android-stopped', {
      platform: 'android',
      id: 'emulator-5556',
      name: 'pixel-8',
      kind: 'emulator',
    }),
  );

  const sessions = await listSessions(sessionStore);
  const ios = sessions.find((session) => session.name === 'ios-1');
  expect(ios?.kind).toBe('simulator');
  expect(ios?.model).toBe('iPhone 17');
  expect(ios?.osVersion).toBe('27.0');

  const android = sessions.find((session) => session.name === 'android-1');
  expect(android?.kind).toBe('emulator');
  expect(android?.model).toBe('sdk_gphone64_arm64');
  expect(android?.osVersion).toBe('16');

  const stopped = sessions.find((session) => session.name === 'android-stopped');
  expect(stopped?.kind).toBe('emulator');
  expect(stopped && 'osVersion' in stopped).toBe(false);
  expect(stopped && 'model' in stopped).toBe(false);
});

async function listSessions(sessionStore: SessionStore): Promise<Array<Record<string, unknown>>> {
  const req: DaemonRequest = {
    token: 't',
    session: 'default',
    command: 'session_list',
    positionals: [],
  };
  const response = await handleSessionInventoryCommands({
    host: createTestHostEnvironment(),
    req,
    sessionName: 'default',
    sessionStore,
    platformServices: daemonPlatformServicesFixture(),
  });
  expect(response?.ok).toBe(true);
  if (!response?.ok) throw new Error('expected session_list to succeed');
  return response.data?.sessions as Array<Record<string, unknown>>;
}
