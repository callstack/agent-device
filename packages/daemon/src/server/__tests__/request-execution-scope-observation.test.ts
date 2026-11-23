import { beforeEach, expect, test, vi } from 'vitest';
import { bindTestCommandHost, createTestHostEnvironment } from '@agent-device/test-kit';
import { buildSnapshotState } from '@agent-device/capture-kit/snapshot-state';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
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
import { createRequestHandler } from '../../__tests__/support/test-device-runtime-gateway.ts';
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
  const closingAt = vi.fn();
  const settlementFor = vi.fn();
  const scope = await createRequestExecutionScope({
    host: createTestHostEnvironment(),
    req,
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    leaseSessionEnd: { closingAt, settlementFor },
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
  if (req.flags?.serial) {
    expect(closingAt).not.toHaveBeenCalled();
    expect(settlementFor).not.toHaveBeenCalled();
  }
  return response;
}

test.each(['platform and serial', 'named session', 'standalone serial'])(
  'Android observation by %s returns geometry without writing session state',
  async (selection) => {
    const sessionStore = makeSessionStore();
    const snapshot = buildSnapshotState(
      { nodes: [{ index: 0, depth: 0, type: 'android.widget.Button', label: 'Pinned baseline' }] },
      {},
    );
    const agent = makeAndroidSession('agent', { sessionScope: { kind: 'named-local' }, snapshot });
    const other = makeIosSession('default', { sessionScope: { kind: 'named-local' } });
    const standalone = selection === 'standalone serial';
    const agentRef = standalone ? undefined : sessionStore.publish('agent', agent);
    const otherRef = standalone ? undefined : sessionStore.publish('default', other);
    const { snapshotGeneration, actions } = agent;
    const previousActions = [...actions];
    const noteActivity = vi.spyOn(sessionStore, 'noteSessionActivity');
    const recordEvent = vi.spyOn(sessionStore, 'recordEvent');
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
      nodes: [
        expect.objectContaining({
          label: 'Live screen',
          rect: { x: 1, y: 2, width: 3, height: 4 },
        }),
      ],
    });
    expect(response.data).not.toHaveProperty('refsGeneration');
    expect(response.data?.nodes).toEqual([expect.not.objectContaining({ ref: expect.anything() })]);
    const retainedAgent = sessionStore.lookup('agent');
    const retainedOther = sessionStore.lookup('default');
    expect(retainedAgent?.lifetime).toBe(agentRef?.lifetime);
    expect(retainedAgent?.session).toBe(standalone ? undefined : agent);
    expect(retainedAgent?.session.snapshot).toBe(standalone ? undefined : snapshot);
    expect(retainedOther?.lifetime).toBe(otherRef?.lifetime);
    expect(retainedOther?.session).toBe(standalone ? undefined : other);
    expect(agent.snapshotGeneration).toBe(snapshotGeneration);
    expect(agent.actions).toEqual(previousActions);
    expect(sessionStore.listRefs()).toHaveLength(standalone ? 0 : 2);
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

test('a refused detached observation never reads the public session address', async () => {
  const sessionStore = makeSessionStore();
  const defaultSession = makeIosSession('default');
  sessionStore.publish('default', defaultSession);
  const lookup = vi.spyOn(sessionStore, 'lookup');
  const device = makeAndroidSession('agent').device;
  vi.mocked(resolveTargetDevice).mockResolvedValue(device);
  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: forwardingCreateCommandSurface,
    logPath: sessionStore.resolveSessionDir('default') + '/daemon.log',
    token: 't',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 't',
    session: 'default',
    command: 'snapshot',
    positionals: [],
    flags: { serial: device.id, snapshotObserveOnly: true, snapshotDiff: true },
  });

  expect(response).toMatchObject({
    ok: false,
    error: { code: 'INVALID_ARGS', details: { reason: 'android_observe_only_snapshot_options' } },
  });
  expect(lookup).not.toHaveBeenCalled();
});
