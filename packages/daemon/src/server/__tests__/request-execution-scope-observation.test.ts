import { beforeEach, expect, test, vi } from 'vitest';
import { bindTestCommandHost, createTestHostEnvironment } from '@agent-device/test-kit';
import { buildSnapshotState } from '@agent-device/capture-kit/snapshot-state';
import { resolveTargetDevice } from '@agent-device/device-selection/dispatch-resolve';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import {
  daemonClaimRecoveryGatewayFixture,
  daemonPlatformServicesFixture,
} from '../../__tests__/support/platform-services-fixture.ts';
import {
  platformRequestScopeFixture,
  unavailableDeviceRuntimeGateway,
} from '../../__tests__/support/unavailable-device-runtime-gateway.ts';
import { makeAndroidSession, makeIosSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { forwardingCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { legacyDispatchCapture } from '../../__tests__/support/legacy-snapshot-capture-fixture.ts';
import { handleSnapshotCommands } from '../../__tests__/support/handlers/snapshot-handler.fixtures.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import {
  createRequestExecutionScope,
  prepareLockedRequestScope,
} from '../request-execution-scope.ts';

vi.mock('@agent-device/device-selection/dispatch-resolve', async (load) => {
  const original = await load<typeof import('@agent-device/device-selection/dispatch-resolve')>();
  return { ...original, resolveTargetDevice: vi.fn() };
});

bindTestCommandHost();

beforeEach(() => {
  vi.mocked(resolveTargetDevice).mockReset();
  legacyDispatchCapture.mockReset();
  legacyDispatchCapture.mockResolvedValue({
    backend: 'android',
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'android.widget.Button',
        label: 'Live screen',
        rect: { x: 1, y: 2, width: 3, height: 4 },
      },
    ],
    viewport: { width: 1080, height: 2400 },
  });
});

async function observe(req: DaemonRequest, sessionStore: ReturnType<typeof makeSessionStore>) {
  const scope = await createRequestExecutionScope({
    host: createTestHostEnvironment(),
    req,
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    platformServices: daemonPlatformServicesFixture(),
    claimRecoveryGateway: daemonClaimRecoveryGatewayFixture(),
    trackClaimRecoveryDisposal: () => {},
    deviceRuntimeGateway: unavailableDeviceRuntimeGateway,
    platformRequestScope: platformRequestScopeFixture(),
  });
  let observation: NonNullable<DaemonRequest['internal']>['snapshotObservation'];
  const response = await scope.runLocked(async () => {
    const prepared = await prepareLockedRequestScope({
      scope,
      sessionStore,
      trackDownloadableArtifact: vi.fn(),
    });
    expect(prepared.type).toBe('scope');
    if (prepared.type !== 'scope') throw new Error('Observation was refused');
    const locked = prepared.scope;
    observation = locked.req.internal?.snapshotObservation;
    expect(observation).toBeDefined();
    expect(locked.existingRef).toBeUndefined();
    const result = await handleSnapshotCommands({
      req: locked.req,
      sessionName: locked.sessionName,
      logPath: locked.logPath,
      sessionStore,
      createCommandSurface: forwardingCreateCommandSurface,
      platformServices: daemonPlatformServicesFixture(),
    });
    if (!result) throw new Error('Snapshot route did not handle observation');
    scope.recordFinished(locked.req, result);
    return result;
  });
  expect(() => observation!.assertCurrent()).toThrow();
  return response;
}

test.each(['serial', 'platform and serial', 'named session'])(
  'Android observation by %s preserves the helper owner and an unrelated default session',
  async (selection) => {
    const sessionStore = makeSessionStore();
    const snapshot = buildSnapshotState(
      { nodes: [{ index: 0, depth: 0, type: 'android.widget.Button', label: 'Pinned baseline' }] },
      {},
    );
    const agent = makeAndroidSession('agent', { sessionScope: { kind: 'named-local' }, snapshot });
    const other = makeIosSession('default', { sessionScope: { kind: 'named-local' } });
    const agentRef = sessionStore.publish('agent', agent);
    const otherRef = sessionStore.publish('default', other);
    const noteActivity = vi.spyOn(sessionStore, 'noteSessionActivity');
    const recordEvent = vi.spyOn(sessionStore, 'recordRequestEvent');
    vi.mocked(resolveTargetDevice).mockResolvedValue(agent.device);

    const response = await observe(
      {
        token: 't',
        session: selection === 'named session' ? 'agent' : 'default',
        command: 'snapshot',
        positionals: [],
        flags: {
          snapshotObserveOnly: true,
          ...(selection === 'named session' ? {} : { serial: agent.device.id }),
          ...(selection === 'platform and serial' ? { platform: 'android' } : {}),
        },
      },
      sessionStore,
    );

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.data).toMatchObject({
      nodes: [expect.objectContaining({ label: 'Live screen' })],
    });
    expect(response.data).not.toHaveProperty('refsGeneration');
    expect(response.data?.nodes).toEqual([expect.not.objectContaining({ ref: expect.anything() })]);
    const retainedAgent = sessionStore.lookup('agent');
    const retainedOther = sessionStore.lookup('default');
    expect(retainedAgent?.lifetime).toBe(agentRef.lifetime);
    expect(retainedAgent?.session).toBe(agent);
    expect(retainedAgent?.session.snapshot).toBe(snapshot);
    expect(retainedOther?.lifetime).toBe(otherRef.lifetime);
    expect(retainedOther?.session).toBe(other);
    expect(noteActivity).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
    expect(legacyDispatchCapture).toHaveBeenCalledOnce();
  },
);

test.each(['lease', 'workspace'])(
  'Android observation refuses a helper owned by another %s before capture',
  async (owner) => {
    const sessionStore = makeSessionStore();
    const agent = makeAndroidSession('agent', {
      sessionScope:
        owner === 'workspace' ? { kind: 'cwd', id: 'another-workspace' } : { kind: 'named-local' },
      ...(owner === 'lease'
        ? {
            lease: {
              backend: 'android-instance',
              leaseId: 'owner',
              tenantId: 'tenant',
              runId: 'run',
            },
          }
        : {}),
    });
    sessionStore.publish('agent', agent);
    vi.mocked(resolveTargetDevice).mockResolvedValue(agent.device);
    const result = observe(
      {
        token: 't',
        session: 'default',
        command: 'snapshot',
        positionals: [],
        flags: { serial: agent.device.id, snapshotObserveOnly: true },
        meta: { cwd: '/workspace/observer' },
      },
      sessionStore,
    );
    await expect(result).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(legacyDispatchCapture).not.toHaveBeenCalled();
  },
);
