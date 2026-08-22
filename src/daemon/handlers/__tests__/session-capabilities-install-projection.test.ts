import { expect, test } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { PUBLIC_COMMANDS } from '../../../command-catalog.ts';
import { makeAndroidSession } from '../../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../request-runtime-binding.ts';
import {
  createCapabilitiesAdmissionRuntime,
  legacyCapabilityUses,
} from './session-capabilities.fixtures.ts';
import { handleSessionCommands } from './session-command-harness.ts';

test('capabilities projects the install family from exactly one facts inspection', async () => {
  const { sessionName, sessionStore } = createAndroidCapabilitiesSession('install-family');
  const runtime = createCapabilitiesAdmissionRuntime({
    appLogAvailable: true,
    networkAvailable: true,
    providerMode: 'local',
    deployAvailable: true,
    sourceAvailable: true,
    pushAvailable: true,
    readinessAvailable: true,
  });

  const response = await dispatchCapabilities({
    sessionName,
    sessionStore,
    bindDevice: runtime.bindDevice,
    inspectFacts: runtime.inspectFacts,
  });

  expect(response).toMatchObject({ ok: true });
  if (!response?.ok) return;
  expect(response.data?.availableCommands).toEqual(
    expect.arrayContaining([
      PUBLIC_COMMANDS.install,
      PUBLIC_COMMANDS.reinstall,
      PUBLIC_COMMANDS.installFromSource,
      PUBLIC_COMMANDS.push,
    ]),
  );
  expect(runtime.inspections).toHaveLength(1);
  expect(runtime.uses).toEqual(legacyCapabilityUses);
});

test('capabilities keeps legacy runtime commands outside the install-family facts projection', async () => {
  const { sessionName, sessionStore } = createAndroidCapabilitiesSession('legacy-runtime');
  const runtime = createCapabilitiesAdmissionRuntime({
    appLogAvailable: true,
    networkAvailable: true,
    providerMode: 'local',
    deployAvailable: true,
    sourceAvailable: true,
    pushAvailable: true,
    readinessAvailable: true,
  });

  const response = await dispatchCapabilities({
    sessionName,
    sessionStore,
    bindDevice: runtime.bindDevice,
    inspectFacts: runtime.inspectFacts,
  });

  expect(response).toMatchObject({ ok: true });
  if (!response?.ok) return;
  // `bootTarget` facts are unavailable in this fixture. A global descriptor projection
  // would hide boot; only this unit's install family is authorized to consume facts.
  expect(response.data?.availableCommands).toContain(PUBLIC_COMMANDS.boot);
  expect(runtime.inspections).toHaveLength(1);
  expect(runtime.uses).toEqual(legacyCapabilityUses);
});

test('capabilities fails closed only for install-family projection when facts inspection fails', async () => {
  const { sessionName, sessionStore } = createAndroidCapabilitiesSession('facts-failure');
  const runtime = createCapabilitiesAdmissionRuntime({
    appLogAvailable: true,
    networkAvailable: true,
    providerMode: 'local',
  });

  const response = await dispatchCapabilities({
    sessionName,
    sessionStore,
    bindDevice: runtime.bindDevice,
    inspectFacts: async () => {
      throw new Error('provider facts unavailable');
    },
  });

  expect(response).toMatchObject({ ok: true });
  if (!response?.ok) return;
  expect(response.data?.availableCommands).toContain(PUBLIC_COMMANDS.boot);
  expect(response.data?.availableCommands).toContain(PUBLIC_COMMANDS.logs);
  expect(response.data?.availableCommands).not.toContain(PUBLIC_COMMANDS.install);
  expect(response.data?.availableCommands).not.toContain(PUBLIC_COMMANDS.reinstall);
  expect(response.data?.availableCommands).not.toContain(PUBLIC_COMMANDS.installFromSource);
  expect(response.data?.availableCommands).not.toContain(PUBLIC_COMMANDS.push);
  expect(runtime.uses).toEqual(legacyCapabilityUses);
});

function createAndroidCapabilitiesSession(suffix: string) {
  const sessionName = `android-capabilities-${suffix}`;
  const sessionStore = makeSessionStore(`agent-device-capabilities-${suffix}-`);
  sessionStore.set(sessionName, makeAndroidSession(sessionName));
  return { sessionName, sessionStore };
}

async function dispatchCapabilities(params: {
  sessionName: string;
  sessionStore: ReturnType<typeof makeSessionStore>;
  bindDevice: BindDeviceRuntime;
  inspectFacts: InspectDeviceRuntimeFacts;
}) {
  return await handleSessionCommands({
    req: {
      token: 't',
      session: params.sessionName,
      command: PUBLIC_COMMANDS.capabilities,
      positionals: [],
      flags: {},
    },
    sessionName: params.sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore: params.sessionStore,
    bindDevice: params.bindDevice,
    inspectFacts: params.inspectFacts,
    invoke: async () => ({ ok: true, data: {} }),
  });
}
