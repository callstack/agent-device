import { expect, test } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { PUBLIC_COMMANDS } from '../../../../command-catalog.ts';
import { makeAndroidSession } from '../../../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../../../__tests__/test-utils/store-factory.ts';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../../request-runtime-binding.ts';
import { createCapabilitiesAdmissionRuntime } from './session-capabilities.fixtures.ts';
import { handleSessionCommands } from '../../../handlers/__tests__/session-command-harness.ts';

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
  // ADR 0019 §6: `capabilities` declares `platformExecution: none`, so it binds nothing. R63
  // retired the three empty-`required` probes that used to answer `logs`/`network`/`record`.
  expect(runtime.uses).toEqual([]);
});

test('capabilities projects every fact-owned command from that same inspection', async () => {
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
  // R63 made the projection global: it reads every migrated command's declared uses, so
  // `bootTarget`/`bootTargetHeadless` being unavailable in this fixture now hides `boot` — where
  // this test previously pinned the opposite, because only the install family consumed facts.
  expect(response.data?.availableCommands).not.toContain(PUBLIC_COMMANDS.boot);
  expect(runtime.inspections).toHaveLength(1);
  expect(runtime.uses).toEqual([]);
});

test('capabilities fails closed for every fact-owned command when facts inspection fails', async () => {
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
  // R63: with no facts at all, every fact-owned command fails closed rather than being advertised
  // on faith — `logs` included. It used to survive on a second `bindDevice` probe, but every owner
  // composes a binding's facts from the same inspection that just failed, so that probe was
  // answering from a path that cannot outlive the inspection it duplicates.
  expect(response.data?.availableCommands).not.toContain(PUBLIC_COMMANDS.boot);
  expect(response.data?.availableCommands).not.toContain(PUBLIC_COMMANDS.logs);
  expect(response.data?.availableCommands).not.toContain(PUBLIC_COMMANDS.install);
  expect(response.data?.availableCommands).not.toContain(PUBLIC_COMMANDS.reinstall);
  expect(response.data?.availableCommands).not.toContain(PUBLIC_COMMANDS.installFromSource);
  expect(response.data?.availableCommands).not.toContain(PUBLIC_COMMANDS.push);
  expect(runtime.uses).toEqual([]);
});

test('capabilities fixture preserves transport mode and owner-specific refusal reasons', async () => {
  const device = makeAndroidSession('fixture-semantics').device;
  const transport = createCapabilitiesAdmissionRuntime({
    appLogAvailable: false,
    networkAvailable: false,
    providerMode: 'transport-composed',
  });
  const provider = createCapabilitiesAdmissionRuntime({
    appLogAvailable: false,
    networkAvailable: false,
    providerMode: 'provider-runtime',
  });

  const transportFacts = await transport.inspectFacts(device);
  const providerFacts = await provider.inspectFacts(device);

  expect(transportFacts.device.providerMode).toBe('transport-composed');
  expect(providerFacts.operations.networkDump).toMatchObject({
    available: false,
    reason: 'unsupported-provider-mode',
  });
  expect(providerFacts.operations.tapRef).toEqual({
    available: false,
    reason: 'owner-capability-missing',
  });
  expect(providerFacts.operations.finalizeApplicationClose).toEqual({
    available: false,
    reason: 'owner-capability-missing',
  });
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
